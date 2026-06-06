# Deploying for your team (Vercel + Postgres)

This gives your team **one shared link** where everyone uploads and downloads the
same catalog. Data lives in a managed Postgres database (shared by everyone);
uploaded files/images are stored in that same database, so there is no
filesystem to manage and it works on Vercel's serverless platform.

> Access: the link is open to anyone who has it (no login), as requested. See
> "Locking it down later" at the end if you want to add a password.

## One-time setup (~10 minutes)

### 1. Import the repo into Vercel
1. Go to **https://vercel.com/new**.
2. Import the GitHub repo **`dhirajjain9/suppliercatalogrepository`**.
3. When asked for the branch, pick the one with this work (`claude/cool-johnson-Rc7FO`)
   or merge it to `main` first. Vercel auto-detects `vercel.json` — just **Deploy**.

The first deploy will succeed but show empty data (it's using a throwaway
database until you add Postgres in the next step).

### 2. Add a Postgres database
1. In the new Vercel project → **Storage** tab → **Create Database** → **Postgres**.
2. Accept the defaults and **connect it to this project**.
3. Vercel automatically adds the connection environment variables (including
   `POSTGRES_URL`) to the project. The app reads `POSTGRES_URL` (or `DATABASE_URL`)
   automatically — no code changes needed.

### 3. Redeploy
Trigger a redeploy (Vercel → Deployments → ⋯ → Redeploy, or push a commit). On
the first request the app creates its tables in Postgres automatically.

### 4. Share the link
Open the project's URL (e.g. `https://your-project.vercel.app`) and send it to
your team. Everyone now reads/writes the same shared catalog.

## How storage works
- **Catalog, suppliers, quotes** → rows in Postgres.
- **Uploaded files & product images** → stored as bytes in Postgres and served
  back through `/api/documents/{id}/download`.
- This keeps the app fully stateless, which is what Vercel's serverless
  functions require.

### Note on scale
Storing images in Postgres is simple and reliable for a small team and product
photos. If you later accumulate **many large images** (hundreds of MB+), the
better home for them is **Vercel Blob** object storage. The upload path is
centralized in `backend/services/storage.py`, so switching images to Blob later
is an isolated change — ask and it can be added.

Also use Vercel Postgres' **pooled** connection string (the default `POSTGRES_URL`)
since serverless functions open many short-lived connections.

## AI extraction for image-only catalogs (optional)
Some supplier catalogs are **image-only PDFs** (slide/brochure exports with no
text layer). These can't be parsed as text, so the app reads them with Claude
vision instead. To enable it:

1. Get an **Anthropic API key** (https://console.anthropic.com).
2. In Vercel → your project → **Settings → Environment Variables**, add:
   - `ANTHROPIC_API_KEY` = your key
   - *(optional)* `VISION_MODEL` = `claude-sonnet-4-6` (default; set
     `claude-haiku-4-5-20251001` for lower cost, `claude-opus-4-8` for best accuracy)
3. **Redeploy.**

Then **Import Catalog** with an image PDF: the app renders each page, the AI
extracts the products (name, specification, color, material, features) and the
company/supplier name, you review the list, and on save the products are added
and the source pages stored as collateral. Each page is sent to the server one
at a time, so file size isn't a constraint. Cost is roughly a few cents to a
small fraction of a dollar per catalog depending on the model and page count.

## Google Chat & Drive import (optional, owner only)
Connect a Google account to import catalogs straight from Google Chat spaces or a
Google Drive folder (e.g. the folder your WhatsApp catalogs get saved into).

1. Create an OAuth client (Google Cloud Console → APIs & Services → Credentials →
   OAuth client ID, type *Web application*). Add the redirect URI
   `https://<your-domain>/api/google/callback`.
2. In Vercel → **Settings → Environment Variables**, add:
   - `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
   - *(optional)* `GOOGLE_REDIRECT_URI` = `https://<your-domain>/api/google/callback`
     (pins the redirect so per-deployment URLs don't cause `redirect_uri_mismatch`)
   - *(optional)* `GOOGLE_DRIVE_FOLDER` = your catalog folder's share link or id —
     **From Drive** then opens straight to that folder by default.
3. **Redeploy**, then in the app use **📨 From Chat** / **📁 From Drive** →
   *Connect Google* once, and import. CSV/Excel/text PDFs import directly;
   image-only PDFs run through the browser AI vision flow.

## Locking it down later
The link is currently open to anyone who has it. To add a single shared password
(no per-user accounts), this can be done with a small middleware + a login screen —
ask when you want it and it'll be wired in.

## Running locally (optional)
Without any database env vars the app uses a local SQLite file — handy for trying
it on your own machine:
```bash
pip install -r requirements.txt
./run.sh          # http://127.0.0.1:8000
```
