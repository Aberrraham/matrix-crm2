# Put the CRM online

This guide uses **Render** to host the website and **Supabase** for the database. Menu names on these sites change now and then. If a button has moved, look for the nearest match.

## What it costs (checked 25 Oct 2026)

| Part | Free | Paid |
| --- | --- | --- |
| Render (the website) | $0, but it falls asleep after 15 minutes with no visitors and takes about a minute to wake. Not suitable for customers. | From $7 a month for the smallest always-on size (512 MB memory) |
| Supabase (the database) | $0, but it pauses after 1 week of no use and has no backups | From $25 a month |
| Domain name (for example matrixescaperooms.com) | not free | About the price of a coffee a month. Paid to a domain seller such as GoDaddy or Namecheap. |

Test on the free plans. Switch both to paid before real customers use it.

## Step 1: Put the code on GitHub

1. Make a free account at github.com.
2. Install **GitHub Desktop** from desktop.github.com.
3. In GitHub Desktop choose **File, Add local repository**, and pick the `matrix-crm` folder. If it says it is not a repository, click "create a repository".
4. Check the changes list. You must NOT see `.env` or `node_modules`. (They are already blocked.)
5. Type a summary such as "First version", then click **Commit to main**.
6. Click **Publish repository**. Tick **Keep this code private**.

## Step 2: Create the website on Render

1. Make an account at render.com. Sign up with GitHub.
2. Click **New**, then **Web Service**.
3. Choose your `matrix-crm` repository.
4. Fill in these boxes:
   - **Language:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance type:** Free for testing, the $7 one for real use
5. Open **Environment Variables** and add these:

| Name | Value |
| --- | --- |
| `DATABASE_URL` | your Supabase Session pooler link (see README) |
| `TRUST_PROXY` | `1` |
| `OTP_SECRET` | a long random value (see `.env.example` for how to make one) |
| `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` | from the README, "Photos and videos". Add them as five separate rows. |
| `MAX_VIDEO_MB` | `50` |

6. Click **Create Web Service**. Wait for "Live" (a few minutes).
7. Open the address at the top (it ends in `.onrender.com`). You should see the welcome screen.

## Step 3: Turn on real OTP before customers come

OTP codes go out on WhatsApp through BhashSMS, using your template `waiver_tra`. The server refuses to run with `NODE_ENV=production` until `BHASH_PASSWORD` is set. This protects you from showing codes on screen.

1. In Render, open **Environment** and add these rows: `BHASH_USER` (`Matrix_BWAPI`), `BHASH_PASSWORD` (the same password you saved as `BHASH_PASSWORD` in your Apps Script), `BHASH_SENDER` (`BUZWAP`), `BHASH_TEMPLATE` (`waiver_tra`).
2. Add `NODE_ENV` with the value `production`.
3. Save. Render restarts the site by itself.
3b. Alternative: if you already have working OTP functions (`sendOtp` and `verifyOtp`), set `OTP_FUNCTIONS_URL` to their base address instead of the BHASH rows. The site then uses them.
4. Look at the Render **Logs** while you test: every send prints the answer BhashSMS gave, which shows why a message did not arrive.
5. Sign up with your own number and check the code arrives.

Until then, do not share the link with the public. In test mode the code is shown on screen, so anyone could sign up with any number.

## Step 4: Use your own web address

1. Buy a domain from a domain seller.
2. In Render, open your service, then **Settings**, then **Custom Domains**, and add it.
3. Render shows the DNS records to add. Add them in the domain seller's DNS page.
4. Wait up to a few hours. The padlock (HTTPS) is added for you.

## Updating the site later

1. Change the files on your computer.
2. In GitHub Desktop, write a summary, click **Commit**, then **Push origin**.
3. Render updates the website by itself.

## Things to know

- **Photos and videos** live in Supabase Storage, not on Render, so they survive restarts and updates. Staff upload them from the dashboard at `/admin/` on the live website.
- **Creating the first owner login** needs one terminal command on your own computer: `npm run admin -- create-owner you@example.com "Your Name"`. It needs your database link in a `.env` file there, and it changes the same live database. After that, add and remove staff from the **Staff accounts** tab at `/admin/`.
- **A large video** upload goes through the website server. On the free Render plan, a slow upload of a big video may time out. The paid plan copes better.
- **Never** put your `.env` file or database password in GitHub, WhatsApp or email.
