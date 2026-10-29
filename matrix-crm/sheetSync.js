'use strict';
// Reads the "FY-26 Q3" tab of your Customer Data Google Sheet (through your Apps Script) and adds
// anyone who is not in the CRM yet: people who signed another waiver, for example people without phones.
// Each new row becomes a customer (no login) plus a waiver for that game, so team and media rules still work.
const db = require('./db');
const S = require('./settings');
const { normPhone, randomCode, isDate, clean } = require('./lib');

const URL_ = () => (process.env.SHEET_SCRIPT_URL || 'https://script.google.com/macros/s/AKfycbw9LvZ-WVTXFSvfCVTS0klaEoHLTtZTNNhxrK8qQv2JahmCTO6KhNRjZNYYhJ-C5KX0/exec').trim();
const TOKEN = () => (process.env.SHEET_SYNC_TOKEN || '').trim();
const enabled = () => !!TOKEN();

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
function validYMD(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
}
// Accepts 2026-10-29, 29 Oct 2026, 29-Oct-2026, 29/10/2026 (day first, as in India), 29.10.2026
function parseDate(v) {
  const s = String(v == null ? '' : v).trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return validYMD(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[\s\-\/.]+([A-Za-z]{3,9})[\s\-\/.,]+(\d{4})/))) { const mo = MON[m[2].slice(0, 4).toLowerCase()] || MON[m[2].slice(0, 3).toLowerCase()]; return mo ? validYMD(+m[3], mo, +m[1]) : null; }
  if ((m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/))) return validYMD(+m[3], +m[2], +m[1]);
  return null;
}
const slotKey = (s) => String(s || '').toUpperCase().replace(/\./g, '').replace(/\s+/g, '').replace(/^0/, '');
function matchSlot(v) { const k = slotKey(v); return S.SLOTS.find((x) => slotKey(x) === k) || clean(v, 20); }
function matchTheme(v) { const k = String(v || '').trim().toLowerCase(); return S.THEMES.find((x) => x.toLowerCase() === k) || clean(v, 40); }
function matchOcc(v) { const k = String(v || '').trim().toLowerCase(); return S.OCCUPATIONS.find((x) => x.toLowerCase() === k) || clean(v, 60) || '-'; }

async function referralCode() {
  for (let i = 0; i < 20; i++) {
    const c = randomCode('MX-', 6);
    if (!(await db.one('SELECT 1 FROM crm_profiles WHERE referral_code = $1', [c]))) return c;
  }
  throw new Error('Could not make a referral code');
}

// One sheet row. Returns {status: 'imported'|'skipped'|'error', note}
async function tx(fn) {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn((text, params) => c.query(text, params));
    await c.query('COMMIT');
    return out;
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* ignore */ } throw e; }
  finally { c.release(); }
}

async function importRow(rowNo, v) {
  const col = (i) => String(v[i] == null ? '' : v[i]).trim();
  const name = clean(col(3), 80);
  const rawPhone = col(4).replace(/[^\d+]/g, '');
  const phone = rawPhone ? normPhone(rawPhone) : null;
  const playDate = parseDate(col(0));
  const theme = matchTheme(col(5));
  const slot = matchSlot(col(6));
  if (!name && !rawPhone && !col(0)) return { status: 'skipped', note: 'Empty row' };
  if (name.length < 2) return { status: 'skipped', note: 'No name' };
  if (!playDate) return { status: 'error', note: 'Date not understood: ' + col(0) };
  if (!theme || !slot) return { status: 'error', note: 'Theme or time slot is empty' };
  if (rawPhone && !phone) return { status: 'error', note: 'Phone number looks wrong: ' + col(4) };

  const dob = parseDate(col(2));
  const pdf = /^https?:\/\//i.test(col(23)) ? col(23).slice(0, 500) : null;

  return tx(async (q) => {
    // Already in the CRM? (people who signed in the CRM are also written to the sheet)
    const dup = await q(
      `SELECT w.id FROM crm_waivers w LEFT JOIN crm_profiles p ON p.user_id = w.user_id
        WHERE w.play_date = $1 AND w.slot = $2 AND w.theme = $3
          AND (($4::text IS NOT NULL AND p.phone = $4) OR lower(w.full_name) = lower($5)) LIMIT 1`,
      [playDate, slot, theme, phone, name]);
    if (dup.rows.length) return { status: 'skipped', note: 'Already in the CRM', waiverId: dup.rows[0].id };

    // Find or make the person
    let userId = null;
    if (phone) {
      const r = await q('SELECT user_id FROM crm_profiles WHERE phone = $1', [phone]);
      if (r.rows.length) userId = r.rows[0].user_id;
    } else {
      const r = await q(
        `SELECT p.user_id FROM crm_profiles p JOIN crm_users u ON u.id = p.user_id
          WHERE p.phone IS NULL AND u.email IS NULL AND lower(p.name) = lower($1) AND ($2::date IS NULL OR p.dob = $2::date) LIMIT 1`, [name, dob]);
      if (r.rows.length) userId = r.rows[0].user_id;
    }
    if (!userId) {
      const u = await q(`INSERT INTO crm_users (email, phone, password_hash) VALUES (NULL, NULL, '!walkin') RETURNING id`);
      userId = u.rows[0].id;
      await q(
        `INSERT INTO crm_profiles (user_id, name, phone, dob, travelling_from, occupation, heard_from, referral_code, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ($9::date + time '12:00') AT TIME ZONE 'Asia/Kolkata')`,
        [userId, name, phone, dob, clean(col(11), 100) || '-', matchOcc(col(12)), clean(col(18), 120) || '-', await referralCode(), playDate]);
    }
    const w = await q(
      `INSERT INTO crm_waivers (user_id, full_name, version, ip, play_date, slot, theme, pdf_url, sheet_synced_at, source, signed_at)
       VALUES ($1, $2, 'sheet', NULL, $3, $4, $5, $6, now(), 'sheet', ($3::date + time '12:00') AT TIME ZONE 'Asia/Kolkata')
       ON CONFLICT (user_id, play_date, slot, theme) DO NOTHING RETURNING id`,
      [userId, name, playDate, slot, theme, pdf]);
    if (!w.rows.length) return { status: 'skipped', note: 'Already in the CRM' };
    return { status: 'imported', note: phone ? 'Added' : 'Added (no phone)', waiverId: w.rows[0].id };
  });
}

let running = false;
// Pulls new rows (and retries earlier problem rows). Returns counts.
async function run() {
  if (!enabled()) return { ok: false, error: 'Sheet sync is not switched on. Add SHEET_SYNC_TOKEN on Render.' };
  if (running) return { ok: false, error: 'A sync is already running. Try again in a minute.' };
  running = true;
  try {
    const last = await db.one(`SELECT COALESCE(MAX(row_no), 1) AS m, (SELECT MIN(row_no) FROM crm_sheet_rows WHERE status = 'error') AS e FROM crm_sheet_rows`);
    const from = Math.max(1, (parseInt(process.env.SHEET_SYNC_FROM_ROW, 10) || 2) - 1);   // optional: ignore old rows above this one
    let after = Math.max(from, Math.min(Number(last.m), last.e ? Number(last.e) - 1 : Infinity));
    const out = { ok: true, imported: 0, skipped: 0, errors: 0, checked: 0 };
    for (let page = 0; page < 40; page++) {
      const res = await fetch(`${URL_()}?action=waivers&after=${after}&token=${encodeURIComponent(TOKEN())}`, { redirect: 'follow', signal: AbortSignal.timeout(60000) });
      let j;
      try { j = await res.json(); } catch (e) { throw new Error('The Google script did not answer with data. Did you add the sync code to it and deploy a new version?'); }
      if (j.status !== 'ok' || !Array.isArray(j.rows)) throw new Error(String(j.message || 'Unexpected reply').slice(0, 200));
      for (const r of j.rows) {
        const rowNo = Number(r.row);
        if (!rowNo || rowNo < 2 || !Array.isArray(r.values)) continue;
        after = Math.max(after, rowNo);
        const done = await db.one('SELECT status FROM crm_sheet_rows WHERE row_no = $1', [rowNo]);
        if (done && done.status !== 'error') continue;
        let o;
        try { o = await importRow(rowNo, r.values); } catch (e) { o = { status: 'error', note: String(e.message).slice(0, 200) }; }
        await db.query(
          `INSERT INTO crm_sheet_rows (row_no, status, note, waiver_id, summary) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (row_no) DO UPDATE SET status = $2, note = $3, waiver_id = $4, summary = $5, checked_at = now()`,
          [rowNo, o.status, o.note || null, o.waiverId || null, [r.values[3], r.values[0], r.values[5], r.values[6]].filter(Boolean).join(' · ').slice(0, 200)]);
        out.checked++;
        if (o.status === 'imported') out.imported++; else if (o.status === 'error') out.errors++; else out.skipped++;
      }
      if (!j.more) break;
    }
    return out;
  } catch (e) {
    console.error('Sheet sync failed -', e.message);
    return { ok: false, error: e.message };
  } finally { running = false; }
}

function start() {
  if (!enabled()) return;
  setTimeout(() => run().then((r) => console.log('Sheet sync:', JSON.stringify(r))), 20000).unref();
  setInterval(() => run().catch(() => {}), 15 * 60 * 1000).unref();
}

module.exports = { run, start, enabled, parseDate, importRow };
