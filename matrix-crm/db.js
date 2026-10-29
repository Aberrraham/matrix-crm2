'use strict';
// Storage layer: PostgreSQL (built for Supabase, works with any Postgres).
const { Pool, types } = require('pg');
const fs = require('fs');
const path = require('path');

// Return plain values instead of strings/objects the front end does not expect.
types.setTypeParser(1082, (v) => v);              // DATE    -> 'YYYY-MM-DD'
types.setTypeParser(20, (v) => parseInt(v, 10));  // BIGINT  -> number
types.setTypeParser(1700, (v) => parseFloat(v));  // NUMERIC -> number

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is missing. Copy .env.example to .env and paste your Supabase connection string.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase needs an encrypted connection. Set DATABASE_SSL=off only for a Postgres on your own computer.
  ssl: process.env.DATABASE_SSL === 'off' ? false : { rejectUnauthorized: false },
  max: Number(process.env.DATABASE_POOL_MAX) || 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});
pool.on('error', (e) => console.error('Database connection error:', e.message));

const query = (text, params) => pool.query(text, params);
const one = async (text, params) => (await pool.query(text, params)).rows[0] || null;
const many = async (text, params) => (await pool.query(text, params)).rows;

// Creates any missing tables. Safe to run on every start.
async function init() {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
}

module.exports = { pool, query, one, many, init };
