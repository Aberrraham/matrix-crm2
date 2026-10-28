'use strict';
// Small helpers shared by the customer side (server.js) and the staff side (adminApi.js).
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const UNIQUE_VIOLATION = '23505'; // Postgres error code for "already exists"

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const clean = (v, max) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');
const fail = (res, code, msg) => res.status(code).json({ error: msg });
// Express 4 does not catch errors from async handlers by itself. This does.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const IST_MS = 5.5 * 3600 * 1000;
const todayIST = () => new Date(Date.now() + IST_MS).toISOString().slice(0, 10);
const addDaysIST = (n) => new Date(Date.now() + IST_MS + n * 86400000).toISOString().slice(0, 10);

const parseId = (v) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const isDate = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
};

// Phone numbers are stored as digits with country code, e.g. 919876543210.
// A 10-digit number is treated as Indian.
function normPhone(input) {
  let d = String(input || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = '91' + d;
  if (d.length < 11 || d.length > 15) return null;
  return d;
}
function normEmail(input) {
  const e = String(input || '').trim().toLowerCase();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return salt.toString('hex') + ':' + key.toString('hex');
}
const DUMMY_HASH = '00'.repeat(16) + ':' + '00'.repeat(64);
async function checkPassword(pw, stored) {
  const [salt, key] = stored.split(':');
  const test = await scrypt(pw, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(test, Buffer.from(key, 'hex'));
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0, O, 1, I or L
function randomCode(prefix, n) {
  let c = prefix;
  for (let i = 0; i < n; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return c;
}
// A one-time password you hand to a new staff member. They must change it at first login.
function tempPassword() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let p = '';
  for (let i = 0; i < 12; i++) p += chars[crypto.randomInt(chars.length)];
  return p;
}

// Simple per-IP limit: at most `max` calls per `windowMs`.
const hits = new Map();
function limit(name, max, windowMs = 60000) {
  return (req, res, next) => {
    const key = name + ':' + req.ip;
    const now = Date.now();
    let e = hits.get(key);
    if (!e || e.reset < now) { e = { n: 0, reset: now + windowMs }; hits.set(key, e); }
    if (++e.n > max) return fail(res, 429, 'Too many attempts. Please wait a minute and try again.');
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of hits) if (e.reset < now) hits.delete(k);
}, 60000).unref();

module.exports = {
  UNIQUE_VIOLATION, sha, clean, fail, wrap, todayIST, addDaysIST, parseId, isDate,
  normPhone, normEmail, hashPassword, checkPassword, DUMMY_HASH, parseCookies,
  randomCode, tempPassword, limit,
};
