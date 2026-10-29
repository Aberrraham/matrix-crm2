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
  DUMMY_HASH, parseCookies, tempPassword, limit, UNIQUE_VIOLATION, todayIST, randomCode,
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
    pdfUrl: w.pdf_url || null, pdfError: w.pdf_error || null,
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

  // Make (or remake) the waiver PDF in Google Drive.
  r.post('/waivers/:id/pdf', auth, ready, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const w = id && await db.one('SELECT id FROM crm_waivers WHERE id = $1', [id]);
    if (!w) return fail(res, 404, 'Waiver not found.');
    const out = await require('./waiverPdf').generate(id);
    if (!out.ok) return fail(res, 502, 'Could not make the PDF: ' + out.error);
    audit(req, 'waiver_pdf', `waiver ${id}`);
    res.json({ ok: true, url: out.url });
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

  /* ---------- everyone who has ever registered, in the order they filled in their details ---------- */
  // seq 1 = the first person to register. People who have not finished their profile are ordered by sign-up time.
  const DIRECTORY_SQL = `
    SELECT * FROM (
      SELECT ROW_NUMBER() OVER (ORDER BY COALESCE(p.created_at, u.created_at), u.id)::int AS seq,
             u.id, u.email, u.phone AS login_phone, u.created_at AS signed_up_at, p.created_at AS profile_at,
             p.name, p.phone, p.dob, p.travelling_from, p.occupation, p.heard_from, p.referral_code,
             (SELECT COUNT(*)::int FROM crm_waivers w WHERE w.user_id = u.id) AS waivers,
             (SELECT COALESCE(SUM(x.delta), 0)::int FROM crm_points x WHERE x.user_id = u.id) AS points
      FROM crm_users u LEFT JOIN crm_profiles p ON p.user_id = u.id
    ) t`;
  const directoryRow = (c) => ({
    seq: c.seq, id: c.id, name: c.name, phone: c.phone || c.login_phone, email: c.email, dob: c.dob, from: c.travelling_from,
    occupation: c.occupation, heardFrom: c.heard_from, referralCode: c.referral_code, signedUpAt: c.signed_up_at,
    profileAt: c.profile_at, waivers: c.waivers, points: c.points, profileDone: !!c.name,
  });
  const directoryWhere = (q) => (q
    ? { sql: ` WHERE (t.name ILIKE $1 OR t.phone ILIKE $1 OR t.login_phone ILIKE $1 OR t.email ILIKE $1 OR t.referral_code ILIKE $1 OR t.occupation ILIKE $1 OR t.travelling_from ILIKE $1)`, params: [like(q)] }
    : { sql: '', params: [] });

  r.get('/directory', auth, ready, wrap(async (req, res) => {
    const q = clean(req.query.q, 80);
    const dir = req.query.order === 'oldest' ? 'ASC' : 'DESC';
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const w = directoryWhere(q);
    const total = (await db.one('SELECT COUNT(*)::int AS n FROM (' + DIRECTORY_SQL + ')' + ' t' + w.sql, w.params)).n;
    const rows = await db.many(DIRECTORY_SQL + w.sql + ` ORDER BY t.seq ${dir} LIMIT 50 OFFSET $${w.params.length + 1}`, [...w.params, offset]);
    const all = (await db.one('SELECT COUNT(*)::int AS n FROM crm_users')).n;
    res.json({ customers: rows.map(directoryRow), total, everyone: all, hasMore: offset + rows.length < total });
  }));

  // Download the whole list as a spreadsheet file (CSV).
  const csvCell = (v) => {
    let t = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // stops a name such as "=1+1" running as a formula in Excel
    return '"' + t.replace(/"/g, '""') + '"';
  };
  r.get('/directory.csv', auth, ready, wrap(async (req, res) => {
    const rows = await db.many(DIRECTORY_SQL + ' ORDER BY t.seq ASC');
    const head = ['No.', 'Name', 'Phone', 'Email', 'Date of birth', 'Travelling from', 'Occupation', 'Heard about us via', 'Referral code', 'Signed up', 'Profile filled', 'Waivers', 'Points'];
    const lines = [head.map(csvCell).join(',')].concat(rows.map((c) => [
      c.seq, c.name, c.phone || c.login_phone, c.email, c.dob, c.travelling_from, c.occupation, c.heard_from, c.referral_code,
      c.signed_up_at && new Date(c.signed_up_at).toISOString(), c.profile_at && new Date(c.profile_at).toISOString(), c.waivers, c.points,
    ].map(csvCell).join(',')));
    audit(req, 'customers_exported', rows.length + ' rows');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="matrix-customers.csv"');
    res.send('\ufeff' + lines.join('\r\n') + '\r\n');
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
    const bal = await db.one('SELECT COALESCE(SUM(delta), 0)::int AS n FROM crm_points WHERE user_id = $1', [id]);
    const led = await db.many(
      `SELECT p.delta, p.reason, p.created_at, s.name AS by FROM crm_points p LEFT JOIN crm_staff s ON s.id = p.created_by
       WHERE p.user_id = $1 ORDER BY p.id DESC LIMIT 30`, [id]);
    const cps = await db.many(
      `SELECT v.code, v.description, v.expires_on, v.redeemed_at FROM crm_vouchers v WHERE v.assigned_to = $1 ORDER BY v.created_at DESC, v.code LIMIT 100`, [id]);
    const today = todayIST();
    res.json({
      customer: { id: c.id, email: c.email, name: c.name, phone: c.phone, dob: c.dob, travellingFrom: c.travelling_from, occupation: c.occupation, heardFrom: c.heard_from },
      waivers: ws.map(rowWaiver),
      points: { balance: bal.n, ledger: led.map((l) => ({ delta: l.delta, reason: l.reason, at: l.created_at, by: l.by })) },
      coupons: cps.map((v) => ({
        code: v.code, description: v.description, expiresOn: v.expires_on, usedAt: v.redeemed_at,
        status: v.redeemed_at ? 'used' : (v.expires_on && v.expires_on < today ? 'expired' : 'active'),
      })),
    });
  }));

  // Take points away from a customer (for example when they spend them). Never below zero.
  r.post('/customers/:id/points/deduct', auth, ready, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const amount = Number(req.body && req.body.amount);
    const reason = clean(req.body && req.body.reason, 200);
    if (!id || !(await db.one('SELECT 1 FROM crm_users WHERE id = $1', [id]))) return fail(res, 404, 'Customer not found.');
    if (!Number.isInteger(amount) || amount < 1 || amount > 1000000) return fail(res, 400, 'Enter a whole number of points, 1 or more.');
    if (reason.length < 2) return fail(res, 400, 'Add a short reason, for example "Redeemed on a booking".');
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [id]); // two staff deducting at once cannot overspend
      const bal = (await client.query('SELECT COALESCE(SUM(delta), 0)::int AS n FROM crm_points WHERE user_id = $1', [id])).rows[0].n;
      if (bal < amount) { await client.query('ROLLBACK'); return fail(res, 409, `This customer only has ${bal} points.`); }
      await client.query('INSERT INTO crm_points (user_id, delta, reason, created_by) VALUES ($1, $2, $3, $4)', [id, -amount, reason, req.staff.id]);
      await client.query('COMMIT');
      audit(req, 'points_deducted', `${amount} from customer ${id}: ${reason}`);
      res.json({ ok: true, balance: bal - amount });
    } catch (e) { try { await client.query('ROLLBACK'); } catch { /* ignore */ } throw e; }
    finally { client.release(); }
  }));

  // Make a coupon for one customer. They see it in their app until the expiry date; after that it is hidden.
  r.post('/customers/:id/coupons', auth, ready, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const b = req.body || {};
    const description = clean(b.description, 200);
    if (!id || !(await db.one('SELECT 1 FROM crm_users WHERE id = $1', [id]))) return fail(res, 404, 'Customer not found.');
    if (description.length < 2) return fail(res, 400, 'Say what the coupon gives, for example "Rs 200 off any room".');
    if (!isDate(b.expiresOn) || b.expiresOn < todayIST()) return fail(res, 400, 'Choose an expiry date that is today or later.');
    let code = clean(b.code, 40).toUpperCase().replace(/\s+/g, '');
    if (code && !/^[A-Z0-9_-]{3,40}$/.test(code)) return fail(res, 400, 'The code can use letters, numbers, - and _ (3 to 40 characters).');
    for (let tries = 0; tries < 10; tries++) {
      const use = code || randomCode('MX', 6);
      try {
        await db.query('INSERT INTO crm_vouchers (code, description, expires_on, assigned_to, created_by) VALUES ($1, $2, $3, $4, $5)',
          [use, description, b.expiresOn, id, req.staff.id]);
        audit(req, 'coupon_created', `${use} for customer ${id}, expires ${b.expiresOn}`);
        return res.json({ ok: true, code: use });
      } catch (e) {
        if (e.code !== UNIQUE_VIOLATION) throw e;
        if (code) return fail(res, 409, 'A coupon with this code already exists.');
      }
    }
    return fail(res, 500, 'Could not make a unique code. Please try again.');
  }));
  r.post('/coupons/:code/use', auth, ready, wrap(async (req, res) => {
    const code = clean(req.params.code, 40).toUpperCase();
    const v = await db.one('UPDATE crm_vouchers SET redeemed_at = now(), redeemed_by = assigned_to WHERE code = $1 AND redeemed_at IS NULL RETURNING code', [code]);
    if (!v) return fail(res, 404, 'That coupon is missing or already used.');
    audit(req, 'coupon_used', code);
    res.json({ ok: true });
  }));
  r.delete('/coupons/:code', auth, ready, wrap(async (req, res) => {
    const code = clean(req.params.code, 40).toUpperCase();
    const v = await db.one('DELETE FROM crm_vouchers WHERE code = $1 RETURNING code', [code]);
    if (!v) return fail(res, 404, 'Not found.');
    audit(req, 'coupon_removed', code);
    res.json({ ok: true });
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
      `SELECT v.code, v.description, v.expires_on, v.redeemed_at, p.name AS for_name
       FROM crm_vouchers v LEFT JOIN crm_profiles p ON p.user_id = COALESCE(v.assigned_to, v.redeemed_by) ORDER BY v.created_at DESC, v.code LIMIT 200`);
    res.json({ vouchers: rows.map((v) => ({ code: v.code, description: v.description, expiresOn: v.expires_on, redeemedAt: v.redeemed_at, redeemedBy: v.for_name })) });
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
