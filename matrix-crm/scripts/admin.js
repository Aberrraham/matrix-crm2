'use strict';
// Terminal helper. Run from the project folder:
//   npm run admin -- create-owner you@example.com "Your Name"   first dashboard account (prints a one-time password)
//   npm run admin -- reset-staff-password someone@example.com   new one-time password, unlocks and re-activates the account
//   npm run admin -- list-staff
//   npm run admin -- add-voucher MX-WELCOME "Rs 200 off any room" 2026-12-31
//   npm run admin -- add-booking 9876543210 2026-10-20 "Room name" 4 3200
//   npm run admin -- list-vouchers
// After the first owner exists, add and remove other staff from the dashboard itself (Staff page).
const db = require('../db');
const { normEmail, normPhone, hashPassword, tempPassword, clean, isDate, UNIQUE_VIOLATION } = require('../lib');
const [cmd, ...a] = process.argv.slice(2);

const stop = (msg) => { console.error(msg); process.exit(1); };

async function main() {
  await db.init();
  if (cmd === 'create-owner') {
    const email = normEmail(a[0]);
    const name = clean(a[1] || '', 80);
    if (!email || name.length < 2) stop('Usage: create-owner EMAIL "Full Name"');
    const temp = tempPassword();
    try {
      await db.query(
        `INSERT INTO crm_staff (email, name, password_hash, role, must_change_password) VALUES ($1, $2, $3, 'owner', true)`,
        [email, name, await hashPassword(temp)]
      );
    } catch (e) {
      if (e.code === UNIQUE_VIOLATION) stop(email + ' already has a dashboard account. Use reset-staff-password if they are locked out.');
      throw e;
    }
    console.log(`Owner created: ${email}`);
    console.log(`One-time password: ${temp}`);
    console.log('Open /admin/ on your website, log in with it, and you will be asked to choose your own password.');
  } else if (cmd === 'reset-staff-password') {
    const email = normEmail(a[0]);
    if (!email) stop('Usage: reset-staff-password EMAIL');
    const staff = await db.one('SELECT id FROM crm_staff WHERE email = $1', [email]);
    if (!staff) stop('No dashboard account for ' + email);
    const temp = tempPassword();
    await db.query(
      `UPDATE crm_staff SET password_hash = $1, must_change_password = true, active = true, failed_attempts = 0, locked_until = NULL WHERE id = $2`,
      [await hashPassword(temp), staff.id]
    );
    await db.query('DELETE FROM crm_staff_sessions WHERE staff_id = $1', [staff.id]);
    console.log(`New one-time password for ${email}: ${temp}`);
  } else if (cmd === 'list-staff') {
    console.table(await db.many(
      `SELECT email, name, role, active, to_char(last_login_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS last_login_ist FROM crm_staff ORDER BY active DESC, role, name`
    ));
  } else if (cmd === 'add-voucher') {
    const [code, description, expires] = a;
    if (!code || !description) stop('Usage: add-voucher CODE "Description" [YYYY-MM-DD]');
    if (expires && !isDate(expires)) stop('Expiry must look like 2026-12-31');
    const c = code.toUpperCase().replace(/\s+/g, '');
    if (!/^[A-Z0-9_-]{3,40}$/.test(c)) stop('The code can only use letters, numbers, - and _ (3 to 40 characters).');
    try {
      await db.query('INSERT INTO crm_vouchers (code, description, expires_on) VALUES ($1, $2, $3)', [c, description, expires || null]);
    } catch (e) {
      if (e.code === UNIQUE_VIOLATION) stop('A voucher with the code ' + c + ' already exists.');
      throw e;
    }
    console.log('Voucher added:', c);
  } else if (cmd === 'add-booking') {
    const [p, date, room, players, amount, status] = a;
    const ph = normPhone(p);
    if (!ph || !isDate(date) || !room) stop('Usage: add-booking PHONE YYYY-MM-DD "Room" [players] [amount] [status]');
    await db.query(
      'INSERT INTO crm_bookings (phone, booked_on, room, players, amount, status) VALUES ($1, $2, $3, $4, $5, $6)',
      [ph, date, room, players ? Number(players) : null, amount ? Number(amount) : null, status || 'Completed']
    );
    console.log('Booking added for', ph);
  } else if (cmd === 'list-vouchers') {
    console.table(await db.many('SELECT code, description, expires_on, redeemed_by FROM crm_vouchers ORDER BY code'));
  } else {
    console.log('Commands: create-owner, reset-staff-password, list-staff, add-voucher, add-booking, list-vouchers');
  }
}

main()
  .catch((e) => { console.error('Failed:', e.message); process.exitCode = 1; })
  .finally(() => db.pool.end());
