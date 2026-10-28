'use strict';
// Staff dashboard API. Everything lives under /api/admin and uses its own login (crm_staff),
// completely separate from customer accounts.
const express = require('express');
const crypto = require('crypto');
const busboy = require('busboy');
const db = require('./db');
const S = require('./settings');
const storage = require('./storage');
const media = require('./media');
const { sendMedia } = require('./serve');
const {
  sha, clean, fail, wrap, parseId, isDate, normEmail, normPhone, hashPassword, checkPassword,
  DUMMY_HASH, parseCookies, tempPassword, limit, UNIQUE_VIOLATION, todayIST,
} = require('./lib');

const PROD = process.env.NODE_ENV === 'production';
const SESSION_MS = 12 * 3600 * 1000;
const MAX_FAILS = 5;
const MIN_PASSWORD = 10;

const like = (q) => '%' + q.replace(/[\\%_]/g, '\\$&') + '%';

module.exports = function mountAdmin(app) {
  const r = express.Router();

  const audit = (req, action, detail) =>
    db.query('INSERT INTO crm_audit (staff_id, action, detail, ip) VALUES ($1, $2, $3, $4)',
      [req.staff ? req.staff.id : null, action, detail ? String(detail).slice(0, 500) : null, req.ip]).catch(() => {});

  const publicStaff = (s) => ({ id: s.id, email: s.email, name: s.name, role: s.role, mustChange: s.must_change_password });

  async function startSession(res, staffId) {
    const token = crypto.randomBytes(32).toString('hex');
    await db.query('INSERT INTO crm_staff_sessions (token_hash, staff_id, expires_at) VALUES ($1, $2, $3)',
      [sha(token), staffId, Date.now() + SESSION_MS]);
    res.cookie('asid', token, { httpOnly: true, sameSite: 'strict', secure: PROD, maxAge: SESSION_MS, path: '/api/admin' });
  }

  /* ---------- login ---------- */
  r.post('/login', limit('alogin', 15), wrap(async (req, res) => {
    const email = normEmail(req.body && req.body.email);
    const password = req.body && req.body.password;
    if (!email || typeof password !== 'string' || !password) return fail(res, 400, 'Enter your email and password.');
    const staff = await db.one('SELECT * FROM crm_staff WHERE email = $1', [email]);
    const usable = staff && staff.active;
    if (usable && staff.locked_until && new Date(staff.locked_until) > new Date()) {
      return fail(res, 423, 'Too many wrong attempts. Please try again in 15 minutes, or ask the owner to reset your password.');
    }
    const ok = await checkPassword(password, usable ? staff.password_hash : DUMMY_HASH);
    if (!usable || !ok) {
      if (usable) {
        await db.query(
          `UPDATE crm_staff SET failed_attempts = failed_attempts + 1,
             locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + interval '15 minutes' ELSE locked_until END
           WHERE id = $1`, [staff.id, MAX_FAILS]);
      }
      return fail(res, 401, 'Wrong email or password.');
    }
    await db.query('UPDATE crm_staff SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [staff.id]);
    await startSession(res, staff.id);
    req.staff = staff;
    audit(req, 'login');
    res.json({ staff: publicStaff(staff) });
  }));

  /* ---------- everything below needs a staff login ---------- */
  const auth = wrap(async (req, res, next) => {
    const token = parseCookies(req.headers.cookie).asid;
    if (!token) return fail(res, 401, 'Please log in.');
    const s = await db.one(
      `SELECT t.* FROM crm_staff_sessions ss JOIN crm_staff t ON t.id = ss.staff_id
       WHERE ss.token_hash = $1 AND ss.expires_at > $2 AND t.active`, [sha(token), Date.now()]);
    if (!s) return fail(res, 401, 'Please log in.');
    req.staff = s;
    req.sessionHash = sha(token);
    next();
  });
  // Staff with a one-time password must choose their own before doing anything else.
  const ready = (req, res, next) =>
    req.staff.must_change_password ? res.status(403).json({ error: 'Please choose your own password first.', mustChange: true }) : next();
  const owner = (req, res, next) => (req.staff.role === 'owner' ? next() : fail(res, 403, 'Only the owner can do this.'));

  r.get('/me', auth, (req, res) => res.json({ staff: publicStaff(req.staff), slots: S.SLOTS, themes: S.THEMES, today: todayIST(), maxVideoMb: Math.round(S.MAX_VIDEO_BYTES / 1048576), storage: storage.enabled }));

  r.post('/logout', auth, wrap(async (req, res) => {
    await db.query('DELETE FROM crm_staff_sessions WHERE token_hash = $1', [req.sessionHash]);
    res.clearCookie('asid', { path: '/api/admin' });
    audit(req, 'logout');
    res.json({ ok: true });
  }));

  r.post('/password', auth, limit('apw', 10), wrap(async (req, res) => {
    const { current, next } = req.body || {};
    if (typeof current !== 'string' || typeof next !== 'string') return fail(res, 400, 'Fill in both boxes.');
    if (next.length < MIN_PASSWORD || next.length > 128) return fail(res, 400, `Your new password must be ${MIN_PASSWORD} to 128 characters.`);
    if (next === current) return fail(res, 400, 'Your new password must be different.');
    if (!(await checkPassword(current, req.staff.password_hash))) return fail(res, 401, 'Your current password is not right.');
    await db.query('UPDATE crm_staff SET password_hash = $1, must_change_password = false WHERE id = $2', [await hashPassword(next), req.staff.id]);
    await db.query('DELETE FROM crm_staff_sessions WHERE staff_id = $1 AND token_hash != $2', [req.staff.id, req.sessionHash]);
    audit(req, 'password_changed');
    res.json({ ok: true });
  }));

  /* ---------- waivers ---------- */
  const TEAM_SIZE = `(SELECT COUNT(*)::int FROM crm_waivers x WHERE x.play_date = w.play_date AND x.slot = w.slot AND x.theme = w.theme AND x.team_access)`;
  const rowWaiver = (w) => ({
    id: w.id, userId: w.user_id, fullName: w.full_name, name: w.profile_name, phone: w.phone, playDate: w.play_date,
    slot: w.slot, theme: w.theme, teamAccess: w.team_access, signedAt: w.signed_at, teamSize: w.team_size,
  });

  // Newest waivers first. ?q= searches name, phone or email.
  r.get('/waivers', auth, ready, wrap(async (req, res) => {
    const q = clean(req.query.q, 80);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const params = [];
    let where = '';
    if (q) {
      params.push(like(q));
      where = `WHERE (w.full_name ILIKE $1 OR p.name ILIKE $1 OR p.phone ILIKE $1 OR u.email ILIKE $1)`;
    }
    params.push(offset);
    const rows = await db.many(
      `SELECT w.*, p.name AS profile_name, p.phone, ${TEAM_SIZE} AS team_size
       FROM crm_waivers w JOIN crm_users u ON u.id = w.user_id LEFT JOIN crm_profiles p ON p.user_id = w.user_id
       ${where} ORDER BY w.signed_at DESC, w.id DESC LIMIT 50 OFFSET $${params.length}`, params);
    res.json({ waivers: rows.map(rowWaiver), hasMore: rows.length === 50 });
  }));

  const validKey = (d, slot, theme) => isDate(d) && typeof slot === 'string' && slot && typeof theme === 'string' && theme;
  const MEDIA_COUNT_AT = `SELECT COUNT(*)::int AS n FROM crm_media WHERE play_date = $1 AND slot = $2 AND theme = $3`;
  const MEMBERS_AT = `SELECT COUNT(*)::int AS n FROM crm_waivers WHERE play_date = $1 AND slot = $2 AND theme = $3 AND team_access AND id != $4`;

  // Would taking this waiver out of its team leave photos with nobody who can see them?
  async function wouldOrphan(w) {
    if (!w.team_access) return false;
    const m = await db.one(MEDIA_COUNT_AT, [w.play_date, w.slot, w.theme]);
    if (!m.n) return false;
    const others = await db.one(MEMBERS_AT, [w.play_date, w.slot, w.theme, w.id]);
    return others.n === 0;
  }

  // Fix a wrong date / slot / theme on a waiver (moves the person to another team).
  r.patch('/waivers/:id', auth, ready, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const w = id && await db.one('SELECT * FROM crm_waivers WHERE id = $1', [id]);
    if (!w) return fail(res, 404, 'Waiver not found.');
    const b = req.body || {};
    const playDate = b.playDate, slot = clean(b.slot, 20), theme = clean(b.theme, 40);
    if (!isDate(playDate)) return fail(res, 400, 'Choose a valid date.');
    if (!S.SLOTS.includes(slot)) return fail(res, 400, 'Choose a time slot from the list.');
    if (!S.THEMES.includes(theme)) return fail(res, 400, 'Choose a theme from the list.');
    const same = playDate === w.play_date && slot === w.slot && theme === w.theme;
    if (!same && (await wouldOrphan(w))) {
      return fail(res, 409, 'This is the last person in a team that already has photos or videos. Delete the media first, or add another teammate.');
    }
    try {
      await db.query('UPDATE crm_waivers SET play_date = $1, slot = $2, theme = $3 WHERE id = $4', [playDate, slot, theme, id]);
    } catch (e) {
      if (e.code === UNIQUE_VIOLATION) return fail(res, 409, 'This person already has a waiver for that date, slot and theme.');
      throw e;
    }
    audit(req, 'waiver_session_changed', `waiver ${id}: ${w.play_date} ${w.slot} ${w.theme} -> ${playDate} ${slot} ${theme}`);
    res.json({ ok: true });
  }));

  // Remove someone from their team (they stop seeing the team's media) or put them back.
  r.patch('/waivers/:id/team', auth, ready, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const w = id && await db.one('SELECT * FROM crm_waivers WHERE id = $1', [id]);
    if (!w) return fail(res, 404, 'Waiver not found.');
    if (typeof (req.body && req.body.access) !== 'boolean') return fail(res, 400, 'Invalid request.');
    const access = req.body.access;
    if (!access && (await wouldOrphan(w))) {
      return fail(res, 409, 'This is the last person in a team that already has photos or videos. Delete the media first, or add another teammate.');
    }
    await db.query('UPDATE crm_waivers SET team_access = $1 WHERE id = $2', [access, id]);
    audit(req, access ? 'team_member_restored' : 'team_member_removed', `waiver ${id}`);
    res.json({ ok: true });
  }));

  /* ---------- sessions (teams) ---------- */
  // Teams from the last N days, newest first.
  r.get('/sessions', auth, ready, wrap(async (req, res) => {
    const from = isDate(req.query.from) ? req.query.from : null;
    const to = isDate(req.query.to) ? req.query.to : null;
    const rows = await db.many(
      `SELECT w.play_date, w.slot, w.theme,
              COUNT(*) FILTER (WHERE w.team_access)::int AS members,
              (SELECT COUNT(*)::int FROM crm_media m WHERE m.play_date = w.play_date AND m.slot = w.slot AND m.theme = w.theme) AS media
       FROM crm_waivers w
       WHERE w.play_date >= COALESCE($1::date, (now() AT TIME ZONE 'Asia/Kolkata')::date - 14)
         AND w.play_date <= COALESCE($2::date, (now() AT TIME ZONE 'Asia/Kolkata')::date + 30)
       GROUP BY w.play_date, w.slot, w.theme
       ORDER BY w.play_date DESC, w.slot, w.theme LIMIT 300`, [from, to]);
    res.json({ sessions: rows.map((x) => ({ playDate: x.play_date, slot: x.slot, theme: x.theme, members: x.members, media: x.media })) });
  }));

  // One team: who is in it, and the photos/videos they all see.
  r.get('/session', auth, ready, wrap(async (req, res) => {
    const { date, slot, theme } = req.query;
    if (!validKey(date, slot, theme)) return fail(res, 400, 'Invalid session.');
    const roster = await db.many(
      `SELECT w.*, p.name AS profile_name, p.phone, 0 AS team_size
       FROM crm_waivers w LEFT JOIN crm_profiles p ON p.user_id = w.user_id
       WHERE w.play_date = $1 AND w.slot = $2 AND w.theme = $3 ORDER BY w.signed_at, w.id`, [date, slot, theme]);
    const files = await db.many(
      `SELECT m.id, m.kind, m.size_bytes, m.created_at, s.name AS uploaded_by
       FROM crm_media m LEFT JOIN crm_staff s ON s.id = m.uploaded_by
       WHERE m.play_date = $1 AND m.slot = $2 AND m.theme = $3 ORDER BY m.created_at DESC, m.id DESC`, [date, slot, theme]);
    res.json({
      session: { playDate: date, slot, theme },
      roster: roster.map(rowWaiver),
      media: files.map((m) => ({ id: m.id, kind: m.kind, size: m.size_bytes, createdAt: m.created_at, uploadedBy: m.uploaded_by })),
    });
  }));

  /* ---------- customers ---------- */
  r.get('/customers', auth, ready, wrap(async (req, res) => {
    const q = clean(req.query.q, 80);
    if (q.length < 2) return res.json({ customers: [] });
    const digits = q.replace(/\D/g, '');
    const rows = await db.many(
      `SELECT u.id, u.email, p.name, p.phone FROM crm_users u LEFT JOIN crm_profiles p ON p.user_id = u.id
       WHERE p.name ILIKE $1 OR u.email ILIKE $1 OR ($2 != '' AND (p.phone LIKE '%' || $2 || '%' OR u.phone LIKE '%' || $2 || '%'))
       ORDER BY p.name NULLS LAST LIMIT 30`, [like(q), digits]);
    res.json({ customers: rows.map((c) => ({ id: c.id, email: c.email, name: c.name, phone: c.phone })) });
  }));

  r.get('/customers/:id', auth, ready, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const c = id && await db.one(
      `SELECT u.id, u.email, p.name, p.phone, p.dob, p.travelling_from, p.occupation, p.heard_from
       FROM crm_users u LEFT JOIN crm_profiles p ON p.user_id = u.id WHERE u.id = $1`, [id]);
    if (!c) return fail(res, 404, 'Customer not found.');
    const ws = await db.many(
      `SELECT w.*, p.name AS profile_name, p.phone, ${TEAM_SIZE} AS team_size FROM crm_waivers w LEFT JOIN crm_profiles p ON p.user_id = w.user_id
       WHERE w.user_id = $1 ORDER BY w.play_date DESC, w.signed_at DESC LIMIT 100`, [id]);
    res.json({
      customer: { id: c.id, email: c.email, name: c.name, phone: c.phone, dob: c.dob, travellingFrom: c.travelling_from, occupation: c.occupation, heardFrom: c.heard_from },
      waivers: ws.map(rowWaiver),
    });
  }));

  /* ---------- photos and videos ---------- */
  // Upload ONE file to a team: POST /api/admin/session/media?date=&slot=&theme=  (multipart, field "file").
  r.post('/session/media', auth, ready, limit('aupload', 120), (req, res, next) => {
    if (!storage.enabled) return fail(res, 503, 'File storage is not set up yet. Finish "Photos and videos" in the README.');
    const { date, slot, theme } = req.query;
    if (!validKey(date, slot, theme)) return fail(res, 400, 'Invalid session.');
    let bb;
    try {
      bb = busboy({ headers: req.headers, limits: { files: 1, fields: 0, fileSize: S.MAX_VIDEO_BYTES } });
    } catch { return fail(res, 400, 'Invalid upload.'); }

    let done = false, chunks = [], truncated = false, got = false;
    const finish = (fn) => { if (!done) { done = true; fn(); } };

    bb.on('file', (name, stream) => {
      got = true;
      stream.on('data', (c) => chunks.push(c));
      stream.on('limit', () => { truncated = true; });
    });
    bb.on('error', () => finish(() => fail(res, 400, 'The upload was interrupted. Please try again.')));
    bb.on('filesLimit', () => finish(() => fail(res, 400, 'Upload one file at a time.')));
    bb.on('close', () => {
      finish(() => (async () => {
        if (!got) return fail(res, 400, 'Choose a photo or video first.');
        if (truncated) return fail(res, 413, `That file is too big. Videos can be up to ${Math.round(S.MAX_VIDEO_BYTES / 1048576)} MB and photos up to ${Math.round(S.MAX_IMAGE_BYTES / 1048576)} MB.`);
        const buf = Buffer.concat(chunks);
        chunks = [];
        const kind = media.sniff(buf);
        if (!kind) return fail(res, 415, 'That file is not a photo or video we can use. Use JPG, PNG, WebP, GIF, MP4, MOV or WebM.');
        if (kind.kind === 'unsupported') return fail(res, 415, 'iPhone HEIC photos are not supported. On the phone, share the photo as "Most Compatible" (JPG), or take a screenshot of it.');
        if (kind.kind === 'image' && buf.length > S.MAX_IMAGE_BYTES) return fail(res, 413, `Photos can be up to ${Math.round(S.MAX_IMAGE_BYTES / 1048576)} MB.`);
        // The team must exist and have at least one person who can see the files.
        const team = await db.one(
          'SELECT 1 FROM crm_waivers WHERE play_date = $1 AND slot = $2 AND theme = $3 AND team_access LIMIT 1', [date, slot, theme]);
        if (!team) return fail(res, 404, 'No waivers match that date, slot and theme, so nobody would see these files.');

        const base = `media/${date}/${crypto.randomUUID()}`;
        let key, thumbKey = null, contentType, body, size;
        if (kind.kind === 'image') {
          let out;
          try { out = await media.processImage(buf); }
          catch { return fail(res, 415, 'That photo looks damaged or is not a supported format.'); }
          key = base + '.jpg'; thumbKey = base + '-thumb.jpg'; contentType = 'image/jpeg'; body = out.display; size = out.display.length;
          await storage.put(thumbKey, out.thumb, 'image/jpeg');
        } else {
          key = `${base}.${kind.ext}`; contentType = kind.contentType; body = buf; size = buf.length;
        }
        await storage.put(key, body, contentType);
        let row;
        try {
          row = await db.one(
            `INSERT INTO crm_media (play_date, slot, theme, kind, object_key, thumb_key, content_type, size_bytes, uploaded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
            [date, slot, theme, kind.kind, key, thumbKey, contentType, size, req.staff.id]);
        } catch (e) {
          storage.remove(key).catch(() => {});
          if (thumbKey) storage.remove(thumbKey).catch(() => {});
          throw e;
        }
        audit(req, 'media_uploaded', `${kind.kind} ${row.id} to ${date} ${slot} ${theme}`);
        res.json({ ok: true, id: row.id, kind: kind.kind });
      })().catch(next));
    });
    req.pipe(bb);
  });

  async function staffMedia(req, res, which) {
    const id = parseId(req.params.id);
    const row = id && await db.one('SELECT * FROM crm_media WHERE id = $1', [id]);
    if (!row) return fail(res, 404, 'Not found');
    return sendMedia(req, res, row, which);
  }
  r.get('/media/:id/file', auth, ready, wrap((req, res) => staffMedia(req, res, 'file')));
  r.get('/media/:id/thumb', auth, ready, wrap((req, res) => staffMedia(req, res, 'thumb')));

  r.delete('/media/:id', auth, ready, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const row = id && await db.one('DELETE FROM crm_media WHERE id = $1 RETURNING *', [id]);
    if (!row) return fail(res, 404, 'Not found');
    if (storage.enabled) {
      storage.remove(row.object_key).catch((e) => console.error('Could not delete file:', e.message));
      if (row.thumb_key) storage.remove(row.thumb_key).catch((e) => console.error('Could not delete thumbnail:', e.message));
    }
    audit(req, 'media_deleted', `${row.kind} ${id} from ${row.play_date} ${row.slot} ${row.theme}`);
    res.json({ ok: true });
  }));

  /* ---------- vouchers and visits ---------- */
  r.get('/vouchers', auth, ready, wrap(async (req, res) => {
    const rows = await db.many(
      `SELECT v.code, v.description, v.expires_on, v.redeemed_at, p.name AS redeemed_by_name
       FROM crm_vouchers v LEFT JOIN crm_profiles p ON p.user_id = v.redeemed_by ORDER BY v.created_at DESC, v.code LIMIT 200`);
    res.json({ vouchers: rows.map((v) => ({ code: v.code, description: v.description, expiresOn: v.expires_on, redeemedAt: v.redeemed_at, redeemedBy: v.redeemed_by_name })) });
  }));
  r.post('/vouchers', auth, ready, wrap(async (req, res) => {
    const b = req.body || {};
    const code = clean(b.code, 40).toUpperCase().replace(/\s+/g, '');
    const description = clean(b.description, 200);
    const expires = b.expiresOn ? b.expiresOn : null;
    if (!/^[A-Z0-9_-]{3,40}$/.test(code)) return fail(res, 400, 'The code can use letters, numbers, - and _ (3 to 40 characters).');
    if (description.length < 2) return fail(res, 400, 'Add a short description.');
    if (expires && !isDate(expires)) return fail(res, 400, 'Choose a valid expiry date.');
    try {
      await db.query('INSERT INTO crm_vouchers (code, description, expires_on) VALUES ($1, $2, $3)', [code, description, expires]);
    } catch (e) {
      if (e.code === UNIQUE_VIOLATION) return fail(res, 409, 'A voucher with this code already exists.');
      throw e;
    }
    audit(req, 'voucher_created', code);
    res.json({ ok: true });
  }));
  r.post('/bookings', auth, ready, wrap(async (req, res) => {
    const b = req.body || {};
    const phone = normPhone(b.phone);
    const room = clean(b.room, 100);
    const players = b.players === '' || b.players == null ? null : Number(b.players);
    const amount = b.amount === '' || b.amount == null ? null : Number(b.amount);
    if (!phone) return fail(res, 400, 'Enter the customer’s phone number.');
    if (!isDate(b.date)) return fail(res, 400, 'Choose a valid date.');
    if (room.length < 2) return fail(res, 400, 'Enter the room.');
    if (players != null && (!Number.isInteger(players) || players < 1 || players > 100)) return fail(res, 400, 'Players must be a whole number.');
    if (amount != null && (!(amount >= 0) || amount > 10000000)) return fail(res, 400, 'Enter a valid amount.');
    await db.query('INSERT INTO crm_bookings (phone, booked_on, room, players, amount, status) VALUES ($1, $2, $3, $4, $5, $6)',
      [phone, b.date, room, players, amount, clean(b.status, 30) || 'Completed']);
    audit(req, 'visit_added', phone);
    res.json({ ok: true });
  }));

  /* ---------- staff accounts (owner only) ---------- */
  const staffRow = (s) => ({
    id: s.id, email: s.email, name: s.name, role: s.role, active: s.active, lastLoginAt: s.last_login_at,
    locked: !!(s.locked_until && new Date(s.locked_until) > new Date()),
  });
  async function lastOwnerGuard(target, res) {
    if (target.role === 'owner' && target.active) {
      const n = await db.one(`SELECT COUNT(*)::int AS n FROM crm_staff WHERE role = 'owner' AND active AND id != $1`, [target.id]);
      if (n.n === 0) { fail(res, 409, 'There must always be at least one active owner.'); return true; }
    }
    return false;
  }

  r.get('/staff', auth, ready, owner, wrap(async (req, res) => {
    const rows = await db.many('SELECT * FROM crm_staff ORDER BY active DESC, role, name');
    res.json({ staff: rows.map(staffRow) });
  }));
  r.post('/staff', auth, ready, owner, wrap(async (req, res) => {
    const email = normEmail(req.body && req.body.email);
    const name = clean(req.body && req.body.name, 80);
    const role = req.body && req.body.role === 'owner' ? 'owner' : 'staff';
    if (!email) return fail(res, 400, 'That email address does not look right.');
    if (name.length < 2) return fail(res, 400, 'Enter their name.');
    const temp = tempPassword();
    try {
      await db.query(`INSERT INTO crm_staff (email, name, password_hash, role, must_change_password, created_by) VALUES ($1, $2, $3, $4, true, $5)`,
        [email, name, await hashPassword(temp), role, req.staff.id]);
    } catch (e) {
      if (e.code === UNIQUE_VIOLATION) return fail(res, 409, 'This email already has a dashboard account.');
      throw e;
    }
    audit(req, 'staff_added', `${email} (${role})`);
    res.json({ ok: true, email, tempPassword: temp }); // shown once
  }));
  r.post('/staff/:id/reset-password', auth, ready, owner, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const t = id && await db.one('SELECT * FROM crm_staff WHERE id = $1', [id]);
    if (!t) return fail(res, 404, 'Not found.');
    const temp = tempPassword();
    await db.query('UPDATE crm_staff SET password_hash = $1, must_change_password = true, failed_attempts = 0, locked_until = NULL WHERE id = $2', [await hashPassword(temp), id]);
    await db.query('DELETE FROM crm_staff_sessions WHERE staff_id = $1', [id]);
    audit(req, 'staff_password_reset', t.email);
    res.json({ ok: true, email: t.email, tempPassword: temp });
  }));
  r.patch('/staff/:id', auth, ready, owner, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const t = id && await db.one('SELECT * FROM crm_staff WHERE id = $1', [id]);
    if (!t) return fail(res, 404, 'Not found.');
    const b = req.body || {};
    const active = typeof b.active === 'boolean' ? b.active : t.active;
    const role = b.role === 'owner' || b.role === 'staff' ? b.role : t.role;
    if (id === req.staff.id && (!active || role !== t.role)) return fail(res, 400, 'You cannot lock yourself out or change your own role.');
    if ((!active || role !== 'owner') && (await lastOwnerGuard(t, res))) return;
    await db.query('UPDATE crm_staff SET active = $1, role = $2 WHERE id = $3', [active, role, id]);
    if (!active) await db.query('DELETE FROM crm_staff_sessions WHERE staff_id = $1', [id]);
    audit(req, 'staff_updated', `${t.email}: active=${active} role=${role}`);
    res.json({ ok: true });
  }));
  r.delete('/staff/:id', auth, ready, owner, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const t = id && await db.one('SELECT * FROM crm_staff WHERE id = $1', [id]);
    if (!t) return fail(res, 404, 'Not found.');
    if (id === req.staff.id) return fail(res, 400, 'You cannot remove your own account.');
    if (await lastOwnerGuard(t, res)) return;
    await db.query('DELETE FROM crm_staff WHERE id = $1', [id]);
    audit(req, 'staff_removed', t.email);
    res.json({ ok: true });
  }));

  r.get('/audit', auth, ready, owner, wrap(async (req, res) => {
    const rows = await db.many(
      `SELECT a.action, a.detail, a.created_at, s.name FROM crm_audit a LEFT JOIN crm_staff s ON s.id = a.staff_id ORDER BY a.id DESC LIMIT 100`);
    res.json({ log: rows.map((a) => ({ action: a.action, detail: a.detail, at: a.created_at, by: a.name })) });
  }));

  r.use((req, res) => fail(res, 404, 'Not found'));
  app.use('/api/admin', r);
};
