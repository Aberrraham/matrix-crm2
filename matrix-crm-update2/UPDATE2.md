# Update 2: waiver PDF to Google Drive + typewriter waiver

## Upload to GitHub
1. Open repo `matrix-crm2` on github.com. In the repo root: **Add file → Upload files**. Drag in `waiverPdf.js` (new), `server.js`, `adminApi.js`, `schema.sql`. Commit.
2. Open the `public` folder on GitHub: **Add file → Upload files**. Drag in `style.css`. Commit.
3. Open `public/admin`: **Add file → Upload files**. Drag in `admin.js`. Commit.

## Render
1. Open your service, then **Manual Deploy → Deploy latest commit**. Wait for "Live".
2. Nothing to add. It uses the same Google script as your old waiver page.
   (To use a different script later, add the variable `WAIVER_PDF_URL`.)

## Check
1. Sign a waiver as a customer. Within a minute, open `/admin/` → Latest waivers.
2. The new **PDF** column shows **Open PDF**. If it shows **Make PDF**, click it to retry.
