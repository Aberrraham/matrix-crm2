'use strict';
// Sends each signed waiver to your existing Google Apps Script, which makes the PDF and saves it in Google Drive.
// The script answers with {status:'ok', pdfUrl:'...'}; we keep that link on the waiver row.
const fs = require('fs');
const path = require('path');
const db = require('./db');

const URL_ = () => (process.env.WAIVER_PDF_URL || 'https://script.google.com/macros/s/AKfycbwT5f9-_ubgKh63kz0mSCY7EhvIk2Zgn8uB7zBBIJqmkiPthfiavxTw5vzimqkpQtA/exec').trim();
const SHEET_URL = () => (process.env.SHEET_SCRIPT_URL || 'https://script.google.com/macros/s/AKfycbw9LvZ-WVTXFSvfCVTS0klaEoHLTtZTNNhxrK8qQv2JahmCTO6KhNRjZNYYhJ-C5KX0/exec').trim();
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function ageFrom(dob, now) {
  const [y, m, d] = dob.split('-').map(Number);
  let a = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d)) a--;
  return a >= 0 ? a + ' years' : '';
}

async function build(id) {
  const w = await db.one(
    `SELECT w.*, p.name, p.phone, p.dob, p.travelling_from, p.occupation, p.heard_from
       FROM crm_waivers w JOIN crm_profiles p ON p.user_id = w.user_id WHERE w.id = $1`, [id]);
  if (!w) return null;
  // Sign date in Indian time
  const ist = new Date(new Date(w.signed_at).getTime() + 330 * 60000);
  let text = '';
  try { text = fs.readFileSync(path.join(__dirname, 'waiver.txt'), 'utf8').trim(); } catch (e) { /* optional */ }
  const phone = String(w.phone || '');
  return {
    date: String(ist.getUTCDate()).padStart(2, '0') + ' ' + MON[ist.getUTCMonth()] + ' ' + ist.getUTCFullYear(),
    day: DAYS[ist.getUTCDay()],
    fullName: w.full_name,
    dob: w.dob,
    age: ageFrom(w.dob, ist),
    phone: phone.length === 12 && phone.startsWith('91') ? phone.slice(2) : phone,
    occupation: w.occupation,
    theme: w.theme,
    timeSlot: w.slot,
    playDate: w.play_date,
    gender: '',
    location: w.travelling_from,
    awareness: w.heard_from,
    waiverAgreed: true,
    cctvConsent: true,
    signatureType: 'type',
    signatureName: w.full_name,
    signatureImage: '',
    waiverText: text,
  };
}

// Returns {ok, url?, error?}. Never throws.
async function generate(id) {
  try {
    const payload = await build(id);
    if (!payload) return { ok: false, error: 'Waiver not found' };
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 60000);
    let res;
    try {
      res = await fetch(URL_(), { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), redirect: 'follow', signal: ctl.signal });
    } finally { clearTimeout(t); }
    let j;
    try { j = await res.json(); } catch (e) { throw new Error('Unexpected reply from the PDF script'); }
    if (!res.ok || j.status !== 'ok' || !j.pdfUrl) throw new Error(String(j.message || 'HTTP ' + res.status).slice(0, 200));
    await db.query('UPDATE crm_waivers SET pdf_url = $1, pdf_error = NULL WHERE id = $2', [String(j.pdfUrl).slice(0, 500), id]);
    const sh = await syncSheet(id, String(j.pdfUrl));
    return { ok: true, url: j.pdfUrl, sheetOk: sh.ok };
  } catch (e) {
    const msg = String(e.message || e).slice(0, 200);
    try { await db.query('UPDATE crm_waivers SET pdf_error = $1 WHERE id = $2', [msg, id]); } catch (e2) { /* ignore */ }
    console.error('Waiver PDF failed for waiver', id, '-', msg);
    return { ok: false, error: msg };
  }
}

// Adds one row to the Customer Data Google Sheet. Done at most once per waiver.
// pdfUrl may be '' (the sheet then shows "Yes" in the Waiver Form column).
async function syncSheet(id, pdfUrl) {
  const claim = await db.one('UPDATE crm_waivers SET sheet_synced_at = now() WHERE id = $1 AND sheet_synced_at IS NULL RETURNING id', [id]);
  if (!claim) return { ok: true, already: true };
  try {
    const payload = await build(id);
    payload.waiverPdfUrl = pdfUrl || '';
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 60000);
    let res;
    try {
      res = await fetch(SHEET_URL(), { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), redirect: 'follow', signal: ctl.signal });
    } finally { clearTimeout(t); }
    let j = {};
    try { j = await res.json(); } catch (e) { /* not json */ }
    if (!res.ok || (j.status !== 'success' && j.status !== 'ok')) throw new Error(String(j.message || 'HTTP ' + res.status).slice(0, 200));
    return { ok: true };
  } catch (e) {
    await db.query('UPDATE crm_waivers SET sheet_synced_at = NULL WHERE id = $1', [id]).catch(() => {});
    console.error('Waiver sheet row failed for waiver', id, '-', e.message);
    return { ok: false, error: e.message };
  }
}

// Try now, then again after 1 and 5 minutes if it failed. Runs in the background.
function generateWithRetry(id) {
  const waits = [60000, 300000];
  const go = async (i) => {
    const r = await generate(id);
    if (r.ok && !r.sheetOk && i < waits.length) {
      // PDF exists but the sheet row failed: retry only the sheet row
      setTimeout(async () => { const s2 = await syncSheet(id, r.url); if (!s2.ok) setTimeout(() => syncSheet(id, r.url), 300000).unref(); }, waits[i]).unref();
      return;
    }
    if (!r.ok && i < waits.length) setTimeout(() => go(i + 1), waits[i]).unref();
    // PDF never worked: still record the person in the sheet (shows "Yes"), so nobody is missing.
    if (!r.ok && i === waits.length) await syncSheet(id, '');
  };
  go(0);
}

module.exports = { generate, generateWithRetry };
