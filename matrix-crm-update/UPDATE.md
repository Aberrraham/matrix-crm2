# Matrix CRM update: referral, coupons, points, all-customers list, new look

Only the changed files are in this folder. Nothing else in the project is touched.
Your database upgrades itself on restart. Customers, waivers and photos stay as they are.

## Upload to GitHub (5 min)
1. Open your repo `matrix-crm2` on github.com.
2. Click **Add file → Upload files**.
3. Drag these 5 files from this folder into the page (they go in the repo root):
   `adminApi.js`, `server.js`, `schema.sql`, `settings.js`, `UPDATE.md` (UPDATE.md is optional).
4. Click **Commit changes**.
5. Open the repo's `public` folder on GitHub, click **Add file → Upload files**, and drag these 5 files:
   `app.js`, `style.css`, `eggs.js`, `r.html`, `r.js`. Commit.
6. Open `public/admin` on GitHub, **Add file → Upload files**, drag `admin.js` and `index.html`. Commit.
7. Open `public/assets` on GitHub, **Add file → Upload files**, drag the 2 `courierprime-...woff2` files. Commit.
   (Tip: upload the files into the folder page itself, not into the repo root, otherwise they land in the wrong place.)

## On Render (2 min)
1. Open your service, then **Environment**.
2. Add one new variable: `PARTNER_API_KEY` = a long random text (about 40 letters and numbers). Save it somewhere private. The coupon website needs it.
3. Click **Manual Deploy → Deploy latest commit**. Wait for "live".

## What's new
- Screen twitch every now and then (customer and admin).
- Black Myth headings on the customer side. Typewriter font for the waiver only.
- Referral: code, WhatsApp share, invite link `yoursite/r/CODE` with a welcome page. Points shown to the customer.
- Points: your coupon website calls `POST /api/partner/referral-use` with header `Authorization: Bearer <PARTNER_API_KEY>` and body `{"code":"MX-ABC123","ref":"unique-id-of-that-use"}`. The code's owner gets the points once per `ref`. The amount is `POINTS_PER_REFERRAL` in `settings.js` (now 100, change it later).
- Admin: in **Find & manage**, open a customer to deduct points and create a coupon with an expiry date.
- Customers see only coupons given to them. Expired ones show no code. The old "enter a voucher code" box is gone.
- Admin: new **All customers** tab, in the order they registered, with search and a spreadsheet download.
