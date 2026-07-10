# Deploy guide — GitHub Pages + Render backend

Two free pieces, both auto-deploy on every push from the same GitHub repo.

- **GitHub Pages** serves the dashboard + chat UI (static HTML/CSS/JS)
- **Render** runs a 60-line Express server that holds the shared Groq key as an env var and proxies `/groq-chat`

All code lives in GitHub. Render just runs the server process — same way Pages runs the static files. The Groq key is set on Render's dashboard, never in the repo.

Visitors just open your Pages URL and use the bot. No Settings modal, no per-user keys.

---

## Part 1 — Push to GitHub (one time, ~2 min)

1. **Unzip** `predictor.zip`. You'll get a folder `universal_ml_predictor/`.
2. Open **GitHub Desktop** → **File → New Repository**.
3. **Local path:** the unzipped folder. **Name:** `predictor`. **Create repository**.
4. **Publish repository** (top bar). Choose your account, **Publish**.

---

## Part 2 — Deploy the backend to Render (one time, ~3 min)

1. Go to **https://render.com** → sign in with GitHub.
2. **New +** → **Web Service**.
3. **Build and deploy from a Git repository** → Next.
4. Find your `predictor` repo → **Connect**.
5. Render reads `render.yaml` and pre-fills everything. Verify:
   - **Name:** `predictor-backend` (or any name)
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Root Directory:** `server`
6. Scroll to **Environment Variables**. Click **Add Environment Variable**:
   - **Key:** `GROQ_API_KEY`
   - **Value:** paste your `gsk_...` key (get one free at https://console.groq.com/keys)
7. Scroll to bottom → **Create Web Service**.
8. Render builds (1–2 min) and gives you a URL like:
   ```
   https://predictor-backend-xyz.onrender.com
   ```
9. Open `https://predictor-backend-xyz.onrender.com/health` in your browser — you should see:
   ```json
   {"ok":true,"service":"predictor-groq-proxy","groq_configured":true}
   ```
   If `groq_configured` is `false`, you forgot step 6.

10. Copy the Render URL — you'll paste it into the frontend in Part 3.

---

## Part 3 — Wire the backend URL into the frontend

1. Open `public/assets/groq.js`. Find this line near the top:
   ```js
   const BACKEND_URL = '';  // ← paste your Render URL here
   ```
2. Replace with your Render URL:
   ```js
   const BACKEND_URL = 'https://predictor-backend-xyz.onrender.com';
   ```
3. Commit + push from GitHub Desktop.

---

## Part 4 — Enable GitHub Pages (one time, ~30 sec)

1. Repo on github.com → **Settings → Pages**.
2. **Source: GitHub Actions** (NOT "Deploy from branch").
3. That's it. The included `.github/workflows/deploy-pages.yml` auto-deploys `public/` to the `gh-pages` branch on every push to `main`.

Your site is live at `https://<yourname>.github.io/predictor/`. Open it, paste a URL, the bot responds.

---

## Part 5 — Auto-deploy the backend on every push (optional, ~2 min)

Render auto-deploys on push by itself (via its GitHub webhook). The included `deploy-render.yml` Action is a **backup** that pokes Render's deploy hook in case the webhook ever fails.

To enable it:

1. On Render: your service → **Settings** → scroll to **Deploy Hook**.
2. Click **Create deploy hook**. Name it `github-actions`. Copy the URL.
3. On GitHub: repo → **Settings → Secrets and variables → Actions** → **New repository secret**:
   - **Name:** `RENDER_DEPLOY_HOOK_URL`
   - **Secret:** paste the URL from step 2.
4. Done. The Action fires on every push that touches `server/` or `render.yaml`.

**Note:** The `GROQ_API_KEY` is NOT in GH secrets — it's set directly on Render (Part 2 step 6). It persists across redeploys automatically.

---

## Verify it works

1. Open your Pages URL: `https://<yourname>.github.io/predictor/`
2. The status chip in the top right should say **"ready"** (green dot).
3. Paste `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_month.geojson` in the chat → Send.
4. The dashboard on the right lights up with 5 charts.
5. Within ~5 seconds the bot replies with a plain-English readout.

---

## Make changes & redeploy

Any commit pushed to `main` triggers:
- `deploy-pages.yml` → updates the Pages site (~30 sec)
- `deploy-render.yml` → triggers Render redeploy (~1 min, only if `server/` or `render.yaml` changed)

Watch progress in your repo's **Actions** tab.

---

## Troubleshooting

**Status chip says "backend URL not set"**
- You skipped Part 3. Edit `public/assets/groq.js` and paste the Render URL into `BACKEND_URL`. Commit + push.

**Bot says "Backend HTTP 500: GROQ_API_KEY not set on server"**
- You skipped Part 2 step 6. On Render → Environment → add `GROQ_API_KEY` = your Groq key. Render redeploys automatically.

**Bot says "Backend HTTP 429"**
- Rate limit hit (5 req/min per IP). Wait 60 seconds.

**Bot says "Groq API HTTP 401"**
- The Groq key is wrong or expired. Update it on Render → Environment.

**Bot says "Groq API HTTP 429"**
- Groq free-tier daily quota exhausted (14,400 req/day). Wait until tomorrow, or upgrade at console.groq.com.

**Render service sleeps after 15 min of inactivity (free tier)**
- First request after sleep takes ~30 seconds to wake up. After that it's fast. Workarounds:
  - Upgrade to Render's $7/mo plan (no sleep).
  - Use [UptimeRobot](https://uptimerobot.com) (free) to ping `/health` every 5 min.

---

## Cost

- **GitHub Pages**: free for public repos.
- **Render**: free tier = 750 hours/month (one always-on web service).
- **Groq**: free tier = 14,400 requests/day, 30 req/min.

**Total: $0/month.**

---

## Why this architecture

| Layer | What it does | Why |
|---|---|---|
| GitHub Pages | Serves static HTML/CSS/JS | Free, always-on, integrated with your repo |
| Render | Holds shared Groq key, proxies /groq-chat | Free, always-on (with sleep), key stays server-side |
| Browser | Renders dashboard, parses files, calls Render | Zero install, zero friction for visitors |

All code and config lives in GitHub. Render is purely a runtime — same way Pages is purely a runtime for the static files. From a control perspective, everything IS in GitHub.

Visitors get the full experience (dashboard + bot) with zero setup. The Groq key is shared across all visitors but rate-limited per IP (5 req/min), so one bad actor can't burn your quota.

This is the same pattern your `dream-framework.com` site uses (Render backend behind the scenes).
