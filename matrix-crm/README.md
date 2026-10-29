# Matrix CRM

Customer portal for Matrix Escape Rooms. Customers sign up, verify their phone by OTP, fill the profile, then use the home menu: waiver, gallery (photos and videos from their team's games), referral code, voucher code and history. Staff use a separate, password-protected dashboard at `/admin/`.

Data is stored in **PostgreSQL on Supabase**. Photos and videos are stored in **private Supabase Storage**.

## Connect the database (once)

1. Go to supabase.com and create a **new project** for the CRM. Do not use your live booking project.
2. Choose a region close to your customers (for India, Mumbai).
3. Make a database password using only letters and numbers. Save it somewhere safe.
4. When the project is ready, click the **Connect** button at the top of the Supabase page.
5. Choose **Session pooler** and copy the link (it starts with `postgresql://`).
6. In this folder, copy `.env.example` to a new file named `.env`.
7. In `.env`, paste the link after `DATABASE_URL=`.
8. In that link, replace `[YOUR-PASSWORD]` with your database password (no brackets).

The tables are created for you the first time the server starts. Nothing to type into Supabase.

## Photos and videos (once)

Without this, everything else works, but staff cannot upload and customers' Gallery stays empty. Menu names in Supabase change now and then. If something has moved, look for the nearest match.

1. In Supabase, open **Storage**.
2. Click **New bucket**. Name it `crm-media`. Leave **Public bucket** switched **off**.
3. Open the S3 connection settings in Storage. Copy the **Endpoint** and the **Region** exactly as shown there.
4. Create a new **S3 access key** on that same page. Copy both the key ID and the secret now. The secret is shown only once.
5. Put the five values into `.env`: `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`.
6. Supabase's free plan allows at most 50 MB per file, so videos are limited to 50 MB (`MAX_VIDEO_MB`).
7. Restart the server. Staff can now upload.

How it works:
- Files are **private**. Every photo and video is checked on every request: only customers in the team it belongs to, or logged-in staff, can open it.
- Files are named randomly and grouped by game date, never by a customer's phone or email.
- Photos are turned the right way up, shrunk to at most 2400 pixels, and hidden data such as GPS location is removed. A small thumbnail is also made.
- HEIC photos (some newer iPhone settings) are not supported. Share them as JPG.
- Videos are stored exactly as uploaded. They have no thumbnail.

## Run it on your computer

1. Install Node.js 20.19 or newer from nodejs.org.
2. Open a terminal in this folder.
3. Run `npm install` (only needed once).
4. Run `npm start`.
5. Open http://localhost:3000 in your browser.

While testing, the OTP is shown on screen and printed in the terminal. No SMS is sent.

## Staff dashboard (`/admin/`)

Staff have their own email + password logins, separate from customers.

**First time (you, the owner), no terminal needed on Render:**
0. In Render, Environment, add `BOOTSTRAP_OWNER_EMAIL` (your email) and `BOOTSTRAP_OWNER_NAME`. After the site restarts, open **Logs** and find `ONE-TIME PASSWORD`. Log in at `/admin/` with it, choose your own password, then delete `BOOTSTRAP_OWNER_EMAIL` from Environment. (The terminal way below also works.)

1. On your computer, in the project folder: `npm run admin -- create-owner you@example.com "Your Name"`
2. It prints a one-time password. Open `https://your-site/admin/`, log in, and choose your own password.

**Adding and removing staff later:** open the **Staff accounts** tab (owners only).
- *Add staff member* gives a one-time password, shown once. Give it to them privately. They must choose their own at first login.
- *Turn off* or *Remove* logs them out straight away. *Reset password* makes a new one-time password and unlocks the account.
- Five wrong passwords lock an account for 15 minutes. If you are locked out as owner: `npm run admin -- reset-staff-password you@example.com`.
- The tab also shows a log of who uploaded, deleted or changed what.

**What staff can do:**
- **Latest waivers:** newest first, with search. "Open team" jumps to that game.
- **Teams & media:** every game (date + time slot + theme), how many people and files. Upload photos and videos (several at once), delete them, remove someone from the team, or fix a wrong date/slot/theme with "Change session".
- **Customers:** search by name, phone or email, see their waivers, open their game.
- **Vouchers & visits:** create vouchers, add a visit to a customer's History.

## How teams work

Everyone whose waiver has the same **Date + Time slot + Theme** is one team. Files are saved against the team, not a person, so a photo added once appears in every teammate's Gallery, including a teammate who signs the waiver later.

Things to know:
- Customers choose their own date, slot and theme, so a wrong pick puts them in the wrong team. Check the people list before uploading. Fix mistakes with **Change session** or **Remove from team**.
- To limit abuse, customers can only pick today up to 30 days ahead (`WAIVER_DAYS_AHEAD` in `settings.js`).
- You cannot move or remove the last person of a team that still has files, so photos are never left with no one able to see them.

## Changing the time slots and themes

Edit `settings.js` (`SLOTS` and `THEMES`) and restart. Keep the spelling stable: teams are matched by exact text.

## Where things are

| Part | File |
| --- | --- |
| Screens (what customers see) | `public/app.js`, `public/style.css`, `public/index.html` |
| Backend, customer side (logins, OTP, waiver, gallery) | `server.js` |
| Backend, staff dashboard | `adminApi.js` |
| Staff dashboard screens | `public/admin/` |
| Lists (themes, time slots, occupations) | `settings.js` |
| Database connection | `db.js` |
| Database tables | `schema.sql` (all tables start with `crm_`) |
| File storage | `storage.js` |
| Photo and video checks | `media.js` |
| Terminal commands | `scripts/admin.js` |
| Waiver wording | `waiver.txt` |
| Font and logo | `public/assets/` |

## Everyday jobs

- **See your data:** Supabase page, **Table Editor**, tables starting with `crm_`.
- **Add a voucher or a visit:** use the dashboard. From the terminal: `npm run admin -- add-voucher MX-WELCOME "Rs 200 off any room" 2026-12-31` or `npm run admin -- add-booking 9876543210 2026-10-20 "Room name" 4 3200`.
- **Change the waiver:** edit `waiver.txt`. Everyone is asked to sign again. Have a lawyer check the wording.
- **Change the occupation or "how did you hear" lists:** edit `settings.js`.

## Keep the data safe

- Never share `.env`. It holds your database password and storage keys.
- Every `crm_` table has row level security switched on with no rules. This blocks Supabase's public web API, so nobody can read customers from outside. Only this server can. Do not add policies or turn this off.
- Do not put Supabase's "anon" or "service_role" keys in this app. It does not need them.
- Storage access keys are like passwords. As far as I know, they can reach every bucket in the Supabase project, which is another reason to keep the CRM in its own project.
- Do not make the `crm-media` bucket public.
- Supabase has daily backups on paid plans. On the free plan, export your tables now and then. Backups of the database do not include the photos and videos.

## Put it online

See **DEPLOY.md** for numbered steps to host it on Render with your own web address.

## Before real customers use it

1. In `.env`, set `NODE_ENV=production`.
2. Set `OTP_SECRET` to a long random value.
3. Set `BHASH_USER` and `BHASH_PASSWORD` (WhatsApp OTP through BhashSMS, template `waiver_tra`). The server refuses to start in production without the password.
4. Host it behind HTTPS (Render, Railway or a VPS with Nginx). Put the same `.env` values in the host's settings and set `TRUST_PROXY=1`.

## Not built yet

- Editing a profile after it is created.
- "Forgot password" (needs the OTP to be reused for a reset).
- Two-step login for staff.
- Optional: staff confirm each team before photos are shared (guards against customers picking someone else's game).
- Customers uploading their own photos.
- Referral rewards. Codes and counts work, but nothing is given out yet.
- Syncing with Google Sheets and Zoho CRM.
- Deleting a customer's account (their files would also need removing from storage).

## Hidden touches (customer side)

Small surprises that never get in the way: the logo and headings glitch now and then (and when the logo is hovered); tapping the logo 5 times, typing `matrix`, or entering the old cheat code (up up down down left right left right b a) plays red digital rain for 5 seconds; the browser tab title changes when you switch away. All of it is in `public/eggs.js` and the end of `public/style.css`. It switches itself off for people who use "reduce motion". To remove it, delete the `eggs.js` line in `public/index.html`.

## Features added later
- Referral codes with WhatsApp share and invite link (`/r/CODE`); points per referral reported by the coupon website (`POST /api/partner/referral-use`, `PARTNER_API_KEY`). Amount: `POINTS_PER_REFERRAL` in `settings.js`.
- Staff can deduct points and give a customer a coupon with an expiry date (Find & manage). Expired coupons hide their code.
- All customers tab (order of registration, search, CSV).
- Every signed waiver is sent to your Google script (PDF in Drive) and a row is added to the Customer Data sheet (`waiverPdf.js`).
- Google Sheet -> CRM import for people without phones (`sheetSync.js`, `docs/google-script-add-on.txt`, `SHEET_SYNC_TOKEN`).
- Look: Black Myth headings, typewriter waiver, red logo glow, faint watermark, occasional screen twitch.

## Environment variables on Render (summary)
DATABASE_URL, OTP_SECRET, OTP_FUNCTIONS_URL, BOOTSTRAP_OWNER_EMAIL (first time only), storage keys (see DEPLOY.md), PARTNER_API_KEY, SHEET_SYNC_TOKEN. Full list with comments: `.env.example`.
