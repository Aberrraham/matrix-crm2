'use strict';
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const S = require('./settings');
const storage = require('./storage');
const { sendMedia } = require('./serve');
const mountAdmin = require('./adminApi');
const waiverPdf = require('./waiverPdf');
const sheetSync = require('./sheetSync');
const {
  sha, clean, fail, wrap, todayIST, addDaysIST, parseId, isDate, normPhone, normEmail,
  hashPassword, checkPassword, DUMMY_HASH, parseCookies, randomCode, tempPassword, limit, UNIQUE_VIOLATION,
} = require('./lib');

const PROD = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3000;
const OTP_SECRET = process.env.OTP_SECRET || 'dev-only-secret-change-me';

if (PROD && (!process.env.OTP_SECRET || !(process.env.BHASH_PASSWORD || process.env.OTP_FUNCTIONS_URL))) {
  console.error('In production you must set OTP_SECRET and either BHASH_PASSWORD (with BHASH_USER) or OTP_FUNCTIONS_URL');
  process.exit(1);
}

const SESSION_MS = 30 * 24 * 3600 * 1000;
const OTP_TTL_MS = 5 * 60 * 1000;

async function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.query('INSERT INTO crm_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
    [sha(token), userId, Date.now() + SESSION_MS]);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: SESSION_MS, path: '/' });
}

async function makeReferralCode() {
  for (let tries = 0; tries < 20; tries++) {
    const c = randomCode('MX-', 6);
    if (!(await db.one('SELECT 1 FROM crm_profiles WHERE referral_code = $1', [c]))) return c;
  }
  throw new Error('Could not make a referral code');
}

// Optional: use your existing, working OTP functions (the sendOtp / verifyOtp pair your waiver page calls)
// instead of calling BhashSMS directly. Set OTP_FUNCTIONS_URL to their base address.
const remoteOtp = () => (process.env.OTP_FUNCTIONS_URL || '').trim().replace(/\/+$/, '');
async function callRemote(fn, params) {
  const q = new URLSearchParams(params);
  const r = await fetch(`${remoteOtp()}/${fn}?${q.toString()}`, { signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* not json */ }
  console.log(`OTP function ${fn} answered HTTP ${r.status}: ${text.slice(0, 200).replace(/\d{6}/g, '******')}`);
  return { ok: r.ok && data.success === true, message: data.message };
}
const tenDigits = (p) => (p.length === 12 && p.startsWith('91') ? p.slice(2) : p);

// WhatsApp OTP through BhashSMS, same call your Apps Script automations use.
// Settings (Render, Environment): BHASH_USER, BHASH_PASSWORD, and optionally
// BHASH_SENDER (default BUZWAP), BHASH_TEMPLATE (default waiver_tra), BHASH_URL.
async function deliverOtp(phone, code) {
  const env = (k, d) => (process.env[k] || '').trim() || d; // ignore stray spaces pasted into the host's settings
  const password = env('BHASH_PASSWORD', '');
  if (!password) {
    console.log(`[DEV OTP] ${phone} -> ${code}`);
    return true; // test mode: nothing is sent
  }
  // BHASH_SEND_91=1 sends 91 + the 10 digits (12 digits). Default sends just the 10 digits, like the Apps Script automations.
  const to = env('BHASH_SEND_91', '') === '1' ? phone : (phone.length === 12 && phone.startsWith('91') ? phone.slice(2) : phone);
  const q = new URLSearchParams({
    user: env('BHASH_USER', 'Matrix_BWAPI'),
    pass: password,
    sender: env('BHASH_SENDER', 'BUZWAP'),
    phone: to,
    text: env('BHASH_TEMPLATE', 'waiver_tra'),
    priority: 'wa',
    stype: 'normal',
    Params: code, // the one blank in the template
  });
  const base = env('BHASH_URL', 'http://bhashsms.com/api/sendmsg.php');
  const shown = new URLSearchParams(q); shown.set('pass', '***'); shown.set('Params', '******');
  console.log('BhashSMS request: ' + base + '?' + shown.toString()); // password and code hidden
  const r = await fetch(base + '?' + q.toString(), { signal: AbortSignal.timeout(10000) });
  const body = (await r.text()).slice(0, 300);
  // Log the provider's answer (never the code or password) so a failed delivery can be diagnosed.
  console.log(`BhashSMS answer for ${to.slice(0, 2)}******${to.slice(-2)} (${to.length} digits, template ${q.get('text')}, sender ${q.get('sender')}, user ${q.get('user')}): HTTP ${r.status} ${body}`);
  if (!r.ok || /invalid|error|fail|not\s+(valid|authori|approved)|insufficient/i.test(body)) {
    throw new Error('BhashSMS rejected the message: ' + body);
  }
  return false;
}

/* ---------- app + middleware ---------- */
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; frame-ancestors 'none'"
  );
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  if (req.path.startsWith('/admin') || req.path.startsWith('/api/admin')) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});
app.use(express.json({ limit: '20kb' }));
// Only JSON bodies may change data (DELETE has no body; HTML forms cannot send DELETE, and cookies are SameSite). Together with SameSite cookies this blocks cross-site form posts.
const UPLOAD_PATH = '/api/admin/session/media';
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE' || req.is('application/json')) return next();
  // The one exception is staff photo/video upload. Another website cannot add this custom header.
  if (req.is('multipart/form-data') && req.path === UPLOAD_PATH && req.get('x-requested-with') === 'crm') return next();
  return fail(res, 415, 'Invalid request');
});

setInterval(async () => {
  const now = Date.now();
  try {
    await db.query('DELETE FROM crm_sessions WHERE expires_at < $1', [now]);
    await db.query('DELETE FROM crm_staff_sessions WHERE expires_at < $1', [now]);
    await db.query('DELETE FROM crm_otps WHERE expires_at < $1', [now - 3600 * 1000]);
  } catch (e) { console.error('Cleanup failed:', e.message); }
}, 60000).unref();

const auth = wrap(async (req, res, next) => {
  const token = parseCookies(req.headers.cookie).sid;
  if (!token) return fail(res, 401, 'Please log in.');
  const row = await db.one(
    `SELECT u.id, u.email, u.phone FROM crm_sessions s JOIN crm_users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > $2`,
    [sha(token), Date.now()]
  );
  if (!row) return fail(res, 401, 'Please log in.');
  req.user = row;
  req.sessionHash = sha(token);
  next();
});
const needProfile = wrap(async (req, res, next) => {
  const p = await db.one('SELECT * FROM crm_profiles WHERE user_id = $1', [req.user.id]);
  if (!p) return fail(res, 403, 'Please finish your profile first.');
  req.profile = p;
  next();
});

/* ---------- public ---------- */
app.get('/api/options', (req, res) => res.json({
  occupations: S.OCCUPATIONS,
  heardFrom: S.HEARD_FROM,
  themes: S.THEMES,
  slots: S.SLOTS,
}));

app.post('/api/signup', limit('auth', 10), wrap(async (req, res) => {
  const { identifier, password } = req.body || {};
  if (typeof identifier !== 'string' || typeof password !== 'string') return fail(res, 400, 'Enter your phone number or email, and a password.');
  if (password.length < 8 || password.length > 128) return fail(res, 400, 'Your password must be 8 to 128 characters.');

  const isEmail = identifier.includes('@');
  const email = isEmail ? normEmail(identifier) : null;
  const phone = isEmail ? null : normPhone(identifier);
  if (isEmail && !email) return fail(res, 400, 'That email address does not look right.');
  if (!isEmail && !phone) return fail(res, 400, 'That phone number does not look right. Use 10 digits.');

  const taken = email
    ? await db.one('SELECT 1 FROM crm_users WHERE email = $1', [email])
    : await db.one('SELECT 1 FROM crm_users WHERE phone = $1', [phone]);
  const exists = 'An account with this ' + (email ? 'email' : 'phone number') + ' already exists. Please log in.';
  if (taken) return fail(res, 409, exists);

  const hash = await hashPassword(password);
  try {
    const row = await db.one(
      'INSERT INTO crm_users (email, phone, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [email, phone, hash]
    );
    await startSession(res, row.id);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === UNIQUE_VIOLATION) return fail(res, 409, exists);
    throw e;
  }
}));

app.post('/api/login', limit('auth', 10), wrap(async (req, res) => {
  const { identifier, password } = req.body || {};
  if (typeof identifier !== 'string' || typeof password !== 'string') return fail(res, 400, 'Enter your phone number or email, and your password.');
  const isEmail = identifier.includes('@');
  const key = isEmail ? normEmail(identifier) : normPhone(identifier);
  let user = null;
  if (key) {
    user = await db.one(`SELECT id, password_hash FROM crm_users WHERE ${isEmail ? 'email' : 'phone'} = $1`, [key]);
    // A user may also have verified a different phone inside their profile.
    if (!user && !isEmail) {
      user = await db.one(
        'SELECT u.id, u.password_hash FROM crm_profiles p JOIN crm_users u ON u.id = p.user_id WHERE p.phone = $1',
        [key]
      );
    }
  }
  const ok = await checkPassword(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) return fail(res, 401, 'Wrong phone/email or password.');
  await startSession(res, user.id);
  res.json({ ok: true });
}));

/* ---------- logged in ---------- */
app.post('/api/logout', auth, wrap(async (req, res) => {
  await db.query('DELETE FROM crm_sessions WHERE token_hash = $1', [req.sessionHash]);
  res.clearCookie('sid', { path: '/' });
  res.json({ ok: true });
}));

app.get('/api/me', auth, wrap(async (req, res) => {
  const p = await db.one('SELECT * FROM crm_profiles WHERE user_id = $1', [req.user.id]);
  // "Signed" means they have a waiver for today or a later game.
  const signed = !!(await db.one('SELECT 1 FROM crm_waivers WHERE user_id = $1 AND play_date >= $2::date', [req.user.id, todayIST()]));
  res.json({
    user: { email: req.user.email, phone: req.user.phone },
    profile: p && {
      name: p.name, phone: p.phone, dob: p.dob, travellingFrom: p.travelling_from,
      occupation: p.occupation, heardFrom: p.heard_from, referralCode: p.referral_code,
    },
    waiverSigned: signed,
  });
}));

/* --- phone OTP --- */
app.post('/api/otp/send', auth, limit('otp', 6), wrap(async (req, res) => {
  const phone = normPhone(req.body && req.body.phone);
  if (!phone) return fail(res, 400, 'That phone number does not look right. Use 10 digits.');
  if (await db.one(`SELECT 1 FROM crm_profiles p JOIN crm_users u ON u.id = p.user_id
                   WHERE p.phone = $1 AND p.user_id != $2 AND NOT (u.email IS NULL AND u.password_hash = '!walkin')`, [phone, req.user.id])) {
    return fail(res, 409, 'This phone number is already registered to another account.');
  }
  const now = Date.now();
  const row = await db.one('SELECT * FROM crm_otps WHERE phone = $1', [phone]);
  let sends = 1, windowStart = now;
  if (row) {
    if (now - row.last_sent < 30000) return fail(res, 429, 'Please wait 30 seconds before asking for a new code.');
    if (now - row.window_start < 3600000) {
      if (row.sends >= 5) return fail(res, 429, 'Too many codes requested. Please try again in an hour.');
      sends = row.sends + 1; windowStart = row.window_start;
    }
  }
  const code = String(crypto.randomInt(100000, 1000000));
  let dev, codeHash = sha(`${OTP_SECRET}:${phone}:${code}`);
  try {
    if (remoteOtp()) {
      const out = await callRemote('sendOtp', { phone: tenDigits(phone) });
      if (!out.ok) throw new Error('OTP function refused: ' + (out.message || 'no reason given'));
      codeHash = 'remote'; // the other service holds the code
    } else {
      dev = await deliverOtp(phone, code);
    }
  } catch (e) { console.error('OTP delivery failed:', e.message); return fail(res, 502, 'We could not send the code. Please try again in a moment.'); }
  await db.query(
    `INSERT INTO crm_otps (phone, code_hash, expires_at, attempts, last_sent, sends, window_start)
     VALUES ($1, $2, $3, 0, $4, $5, $6)
     ON CONFLICT (phone) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at,
       attempts = 0, last_sent = EXCLUDED.last_sent, sends = EXCLUDED.sends, window_start = EXCLUDED.window_start`,
    [phone, codeHash, now + OTP_TTL_MS, now, sends, windowStart]
  );
  res.json({ ok: true, phone, devCode: dev && !PROD ? code : undefined });
}));

app.post('/api/otp/verify', auth, limit('otpv', 15), wrap(async (req, res) => {
  const phone = normPhone(req.body && req.body.phone);
  const code = clean(req.body && req.body.code, 10);
  if (!phone || !/^\d{6}$/.test(code)) return fail(res, 400, 'Enter the 6-digit code.');
  const row = await db.one('SELECT * FROM crm_otps WHERE phone = $1', [phone]);
  if (!row || row.expires_at < Date.now()) return fail(res, 400, 'This code has expired. Please ask for a new one.');
  if (row.attempts >= 5) {
    await db.query('DELETE FROM crm_otps WHERE phone = $1', [phone]);
    return fail(res, 429, 'Too many wrong tries. Please ask for a new code.');
  }
  let good;
  if (row.code_hash === 'remote') {
    try { good = (await callRemote('verifyOtp', { phone: tenDigits(phone), code })).ok; }
    catch (e) { console.error('OTP check failed:', e.message); return fail(res, 502, 'We could not check the code. Please try again.'); }
  } else {
    good = crypto.timingSafeEqual(Buffer.from(sha(`${OTP_SECRET}:${phone}:${code}`)), Buffer.from(row.code_hash));
  }
  if (!good) {
    await db.query('UPDATE crm_otps SET attempts = attempts + 1 WHERE phone = $1', [phone]);
    return fail(res, 400, 'That code is not right. Please check and try again.');
  }
  await db.query('DELETE FROM crm_otps WHERE phone = $1', [phone]);
  await db.query(
    `INSERT INTO crm_phone_verifications (user_id, phone) VALUES ($1, $2)
     ON CONFLICT (user_id, phone) DO UPDATE SET verified_at = now()`,
    [req.user.id, phone]
  );
  res.json({ ok: true, phone });
}));

/* --- profile --- */
// A person added from the Google Sheet has no login. When they sign up with the same phone number,
// move their waivers, points and coupons onto the new account and remove the empty placeholder.
async function adoptSheetPerson(newUserId, phone) {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    const old = (await c.query(
      `SELECT u.id FROM crm_profiles p JOIN crm_users u ON u.id = p.user_id
        WHERE p.phone = $1 AND u.email IS NULL AND u.password_hash = '!walkin' FOR UPDATE`, [phone])).rows[0];
    if (!old) { await c.query('ROLLBACK'); return false; }
    await c.query(
      `UPDATE crm_waivers w SET user_id = $1 WHERE user_id = $2
         AND NOT EXISTS (SELECT 1 FROM crm_waivers x WHERE x.user_id = $1 AND x.play_date = w.play_date AND x.slot = w.slot AND x.theme = w.theme)`, [newUserId, old.id]);
    await c.query('UPDATE crm_points SET user_id = $1 WHERE user_id = $2', [newUserId, old.id]);
    await c.query('UPDATE crm_vouchers SET assigned_to = $1 WHERE assigned_to = $2', [newUserId, old.id]);
    await c.query('UPDATE crm_vouchers SET redeemed_by = $1 WHERE redeemed_by = $2', [newUserId, old.id]);
    await c.query('UPDATE crm_profiles SET referred_by = $1 WHERE referred_by = $2', [newUserId, old.id]);
    await c.query('DELETE FROM crm_users WHERE id = $1', [old.id]);
    await c.query('COMMIT');
    return true;
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* ignore */ } throw e; }
  finally { c.release(); }
}

app.post('/api/profile', auth, wrap(async (req, res) => {
  const b = req.body || {};
  const name = clean(b.name, 80);
  const travellingFrom = clean(b.travellingFrom, 100);
  const heardFrom = clean(b.heardFrom, 120);
  const occupation = typeof b.occupation === 'string' ? b.occupation : '';
  const phone = normPhone(b.phone);
  const dob = typeof b.dob === 'string' ? b.dob : '';

  if (name.length < 2) return fail(res, 400, 'Please enter your name.');
  if (!phone) return fail(res, 400, 'Please enter your phone number.');
  if (!isDate(dob) || dob > todayIST() || dob < '1900-01-01') return fail(res, 400, 'Please enter a valid date of birth.');
  if (travellingFrom.length < 2) return fail(res, 400, 'Please tell us where you are travelling from.');
  if (!S.OCCUPATIONS.includes(occupation)) return fail(res, 400, 'Please choose your occupation.');
  if (heardFrom.length < 2) return fail(res, 400, 'Please tell us how you heard about us.');

  if (!(await db.one('SELECT 1 FROM crm_phone_verifications WHERE user_id = $1 AND phone = $2', [req.user.id, phone]))) {
    return fail(res, 400, 'Please verify your phone number with the OTP first.');
  }
  if (await db.one('SELECT 1 FROM crm_profiles WHERE user_id = $1', [req.user.id])) {
    return fail(res, 409, 'Your profile already exists.');
  }
  const run = async () => {
    const code = await makeReferralCode();
    await db.query(
      `INSERT INTO crm_profiles (user_id, name, phone, dob, travelling_from, occupation, heard_from, referral_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [req.user.id, name, phone, dob, travellingFrom, occupation, heardFrom, code]
    );
  };
  try {
    try { await run(); } catch (e) {
      if (e.code !== UNIQUE_VIOLATION) throw e;
      // Maybe this number belongs to a person staff imported from the Google Sheet (no login yet): join them up.
      if (!(await adoptSheetPerson(req.user.id, phone))) throw e;
      await run();
    }
    res.json({ ok: true });
  } catch (e) {
    if (e.code === UNIQUE_VIOLATION) return fail(res, 409, 'This phone number is already registered to another account.');
    throw e;
  }
}));

/* --- waiver: one per person per game (date + time slot + theme) --- */
function waiverInfo() {
  const text = fs.readFileSync(path.join(__dirname, 'waiver.txt'), 'utf8').trim();
  return { text, version: sha(text).slice(0, 10) };
}
app.get('/api/waiver', auth, needProfile, wrap(async (req, res) => {
  const rows = await db.many(
    `SELECT id, full_name, play_date, slot, theme, signed_at FROM crm_waivers
     WHERE user_id = $1 AND play_date IS NOT NULL ORDER BY play_date DESC, signed_at DESC LIMIT 50`,
    [req.user.id]
  );
  res.json({
    text: waiverInfo().text,
    today: todayIST(),
    lastDate: addDaysIST(S.WAIVER_DAYS_AHEAD),
    waivers: rows.map((r) => ({ id: r.id, fullName: r.full_name, playDate: r.play_date, slot: r.slot, theme: r.theme, signedAt: r.signed_at })),
  });
}));
app.post('/api/waiver', auth, needProfile, limit('waiver', 20), wrap(async (req, res) => {
  const b = req.body || {};
  const fullName = clean(b.fullName, 80);
  const slot = clean(b.slot, 20);
  const theme = clean(b.theme, 40);
  if (b.agree !== true) return fail(res, 400, 'Please tick the box to confirm you agree.');
  if (b.cctv !== true) return fail(res, 400, 'Please tick the box to consent to CCTV surveillance.');
  if (fullName.length < 2) return fail(res, 400, 'Please type your full name as your signature.');
  if (!isDate(b.playDate) || b.playDate < todayIST() || b.playDate > addDaysIST(S.WAIVER_DAYS_AHEAD)) {
    return fail(res, 400, 'Please choose the date you are playing. It must be today or up to ' + S.WAIVER_DAYS_AHEAD + ' days ahead.');
  }
  if (!S.SLOTS.includes(slot)) return fail(res, 400, 'Please choose your time slot.');
  if (!S.THEMES.includes(theme)) return fail(res, 400, 'Please choose your theme.');
  try {
    const ins = await db.one(
      'INSERT INTO crm_waivers (user_id, full_name, version, ip, play_date, slot, theme) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [req.user.id, fullName, waiverInfo().version, req.ip, b.playDate, slot, theme]
    );
    waiverPdf.generateWithRetry(ins.id); // PDF to Google Drive, in the background
  } catch (e) {
    if (e.code === UNIQUE_VIOLATION) return fail(res, 409, 'You have already signed the waiver for that game.');
    throw e;
  }
  res.json({ ok: true });
}));

/* --- photos and videos: shared with everyone in the same team --- */
const IN_MY_TEAM = `EXISTS (SELECT 1 FROM crm_waivers w WHERE w.user_id = $1 AND w.team_access
                     AND w.play_date = m.play_date AND w.slot = m.slot AND w.theme = m.theme)`;

app.get('/api/media', auth, needProfile, wrap(async (req, res) => {
  const rows = await db.many(
    `SELECT m.id, m.kind, m.size_bytes, m.created_at, m.play_date, m.slot, m.theme FROM crm_media m
     WHERE ${IN_MY_TEAM} ORDER BY m.play_date DESC, m.created_at DESC, m.id DESC LIMIT 500`,
    [req.user.id]
  );
  res.json({
    media: rows.map((r) => ({ id: r.id, kind: r.kind, size: r.size_bytes, createdAt: r.created_at, playDate: r.play_date, slot: r.slot, theme: r.theme })),
  });
}));

async function customerMedia(req, res, which) {
  const id = parseId(req.params.id);
  const row = id ? await db.one(`SELECT m.* FROM crm_media m WHERE m.id = $2 AND ${IN_MY_TEAM}`, [req.user.id, id]) : null;
  if (!row) return fail(res, 404, 'Not found'); // same answer whether it does not exist or belongs to another team
  return sendMedia(req, res, row, which);
}
app.get('/api/media/:id/file', auth, wrap((req, res) => customerMedia(req, res, 'file')));
app.get('/api/media/:id/thumb', auth, wrap((req, res) => customerMedia(req, res, 'thumb')));

/* --- referral: a code to share, a link, and points --- */
async function pointsFor(userId) {
  const bal = await db.one('SELECT COALESCE(SUM(delta), 0)::int AS n FROM crm_points WHERE user_id = $1', [userId]);
  const rows = await db.many('SELECT delta, reason, created_at FROM crm_points WHERE user_id = $1 ORDER BY id DESC LIMIT 30', [userId]);
  return { balance: bal.n, history: rows.map((r) => ({ delta: r.delta, reason: r.reason, at: r.created_at })) };
}
app.get('/api/referral', auth, needProfile, wrap(async (req, res) => {
  const { n } = await db.one('SELECT COUNT(*)::int AS n FROM crm_profiles WHERE referred_by = $1', [req.user.id]);
  const pts = await pointsFor(req.user.id);
  res.json({
    code: req.profile.referral_code,
    friendsJoined: n,
    usedFriendsCode: req.profile.referred_by != null,
    points: pts.balance,
    pointsHistory: pts.history,
    pointsPerFriend: S.POINTS_PER_REFERRAL,
  });
}));
app.post('/api/referral/apply', auth, needProfile, limit('ref', 10), wrap(async (req, res) => {
  const code = clean(req.body && req.body.code, 20).toUpperCase();
  if (req.profile.referred_by != null) return fail(res, 409, 'You have already used a friend’s code.');
  const owner = await db.one('SELECT user_id FROM crm_profiles WHERE referral_code = $1', [code]);
  if (!owner) return fail(res, 404, 'We could not find that referral code.');
  if (owner.user_id === req.user.id) return fail(res, 400, 'You cannot use your own code.');
  await db.query('UPDATE crm_profiles SET referred_by = $1 WHERE user_id = $2 AND referred_by IS NULL', [owner.user_id, req.user.id]);
  res.json({ ok: true });
}));

// Public: lets the invite page check a code. It reveals nothing about who owns it.
app.get('/api/referral/check', limit('refcheck', 30), wrap(async (req, res) => {
  const code = clean(req.query.code, 20).toUpperCase();
  const ok = /^[A-Z0-9-]{4,20}$/.test(code) && !!(await db.one('SELECT 1 FROM crm_profiles WHERE referral_code = $1', [code]));
  res.json({ valid: ok, code: ok ? code : null });
}));

// For your coupon website (server to server). It reports "this referral code was just used" and the code's owner
// earns points. Protected by a secret key (PARTNER_API_KEY in the host's settings), sent as: Authorization: Bearer <key>
// Body: { "code": "MX-ABC123", "ref": "optional-unique-id-of-this-use" }. Sending the same ref twice credits only once.
app.post('/api/partner/referral-use', limit('partner', 120), wrap(async (req, res) => {
  const key = (process.env.PARTNER_API_KEY || '').trim();
  if (!key) return fail(res, 503, 'Not enabled.');
  const given = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(sha(given)), b = Buffer.from(sha(key));
  if (!crypto.timingSafeEqual(a, b)) return fail(res, 401, 'Not allowed.');
  const code = clean(req.body && req.body.code, 20).toUpperCase();
  const ref = clean(req.body && req.body.ref, 80) || null;
  const owner = await db.one('SELECT user_id FROM crm_profiles WHERE referral_code = $1', [code]);
  if (!owner) return fail(res, 404, 'Unknown referral code.');
  try {
    await db.query('INSERT INTO crm_points (user_id, delta, reason, ref) VALUES ($1, $2, $3, $4)',
      [owner.user_id, S.POINTS_PER_REFERRAL, 'A friend used your referral code', ref]);
  } catch (e) {
    if (e.code === UNIQUE_VIOLATION) return fail(res, 409, 'This use was already counted.');
    throw e;
  }
  const pts = await pointsFor(owner.user_id);
  res.json({ ok: true, pointsAdded: S.POINTS_PER_REFERRAL, balance: pts.balance });
}));

/* --- coupons: made by staff for one customer. Customers can only look at their own. --- */
app.get('/api/vouchers', auth, needProfile, wrap(async (req, res) => {
  const today = todayIST();
  const rows = await db.many(
    `SELECT code, description, expires_on, redeemed_at FROM crm_vouchers
     WHERE assigned_to = $1 OR redeemed_by = $1 ORDER BY created_at DESC, code LIMIT 100`,
    [req.user.id]
  );
  res.json({
    vouchers: rows.map((r) => {
      const status = r.redeemed_at ? 'used' : (r.expires_on && r.expires_on < today ? 'expired' : 'active');
      // Once a coupon has expired the code is no longer shown.
      return { code: status === 'expired' ? null : r.code, description: r.description, expiresOn: r.expires_on, status };
    }),
  });
}));

/* --- history --- */
app.get('/api/history', auth, needProfile, wrap(async (req, res) => {
  const rows = await db.many(
    'SELECT booked_on, room, players, amount, status FROM crm_bookings WHERE phone = $1 ORDER BY booked_on DESC, id DESC LIMIT 200',
    [req.profile.phone]
  );
  res.json({
    bookings: rows.map((r) => ({ date: r.booked_on, room: r.room, players: r.players, amount: r.amount, status: r.status })),
  });
}));

/* ---------- invite page: /r/MX-ABC123 (what a friend sees when they open a shared link) ---------- */
app.get('/r/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'r.html')));

/* ---------- staff dashboard (its own login, see adminApi.js) ---------- */
mountAdmin(app);

/* ---------- static files + errors ---------- */
app.use('/api', (req, res) => fail(res, 404, 'Not found'));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use((err, req, res, next) => {
  if (err.status && err.status < 500) return fail(res, err.status, 'Invalid request');
  console.error(err);
  fail(res, 500, 'Something went wrong. Please try again.');
});

// First-time setup without a terminal: if BOOTSTRAP_OWNER_EMAIL is set in the host's settings and no staff
// account exists yet, make that person the owner and print a one-time password in the log (once).
async function bootstrapOwner() {
  const email = normEmail(process.env.BOOTSTRAP_OWNER_EMAIL);
  if (!email) return;
  if (await db.one('SELECT 1 FROM crm_staff LIMIT 1')) return;
  const temp = tempPassword();
  await db.query(
    `INSERT INTO crm_staff (email, name, password_hash, role, must_change_password) VALUES ($1, $2, $3, 'owner', true)`,
    [email, clean(process.env.BOOTSTRAP_OWNER_NAME || 'Owner', 80) || 'Owner', await hashPassword(temp)]
  );
  console.log('==============================================');
  console.log(`OWNER CREATED: ${email}`);
  console.log(`ONE-TIME PASSWORD: ${temp}`);
  console.log('Log in at /admin/ and choose your own password. Then delete BOOTSTRAP_OWNER_EMAIL from the settings.');
  console.log('==============================================');
}

db.init()
  .then(bootstrapOwner)
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Matrix CRM running at http://localhost:${PORT}  (staff dashboard: /admin/)`);
      sheetSync.start();
      if (!process.env.BHASH_PASSWORD) console.log('Test mode: OTP codes are shown on screen and printed here.');
    });
  })
  .catch((e) => {
    console.error('Could not connect to the database:', e.message);
    console.error('Check DATABASE_URL in your .env file (see README, "Connect the database").');
    process.exit(1);
  });
