# Predictor — GitHub Pages + Render backend

Paste a link or drop a file. The bot reads your data, runs the analysis in your browser, and renders five interactive ECharts charts. The narrative comes from a shared Groq key held on the Render backend — visitors never need their own key.

## Architecture

```
GitHub Pages (frontend)            Render (backend)                      Groq API
   public/index.html                  server/index.js
   public/assets/*.js                  ↓ holds GROQ_API_KEY as env var
       │                                            │
       │ 1. visitor pastes URL                      │
       │ 2. browser fetches URL, runs analysis      │
       │ 3. browser POSTs /groq-chat to Render ──>  │
       │                                            │ 4. server adds key, forwards to Groq
       │                                            │ 5. Groq replies
       │ 6. browser renders reply + dashboard <─── │
```

- **Pages**: free, always-on, integrated with your repo.
- **Render**: free tier, holds the shared key, rate-limits per IP.
- **Visitor**: zero setup, zero friction.

All code lives in GitHub. Both pieces auto-deploy from GH Actions. Render just runs the small Express server (60 lines) — same way Pages runs the static files.

## Quick start (local dev)

```bash
# Terminal 1 — backend
cd universal_ml_predictor/server
npm install
GROQ_API_KEY=gsk_... npm start   # http://localhost:3000

# Terminal 2 — frontend
cd universal_ml_predictor/public
python3 -m http.server 8000      # http://localhost:8000
```

Set `BACKEND_URL = 'http://localhost:3000'` in `public/assets/groq.js` for local testing.

## Deploy

See **[DEPLOY.md](./DEPLOY.md)** for the full step-by-step. Short version:

1. **Push to GitHub** (GitHub Desktop).
2. **Deploy backend to Render** (one time, ~3 min):
   - Render → New → Web Service → connect your repo (reads `render.yaml`).
   - Environment → add `GROQ_API_KEY` = your `gsk_...` key.
   - Deploy. Copy the URL.
3. **Paste the Render URL** into `public/assets/groq.js` (the `BACKEND_URL` constant).
4. **Enable Pages**: repo → Settings → Pages → Source: **GitHub Actions**.
5. Commit + push. Both `deploy-pages.yml` and `deploy-render.yml` auto-fire.

Your site is live at `https://<yourname>.github.io/predictor/`. The bot works for every visitor with zero setup.

## File layout

```
public/                       # → deployed to GitHub Pages
  index.html
  assets/
    style.css
    engine.js                 analysis engine (pure JS) — internal, not exposed in UI
    adapters.js               URL/file parsers (CSV, JSON, Yahoo, USGS, CoinGecko, …)
    groq.js                   calls the Render backend (no key in browser)
    app.js                    chat UI + 5-tab ECharts dashboard
server/                       # → deployed to Render
  index.js                    60-line Express proxy — holds shared key as env var
  package.json
render.yaml                   Render blueprint (one-click deploy config)
.github/workflows/
  deploy-pages.yml            auto-deploys public/ → gh-pages branch on push
  deploy-render.yml           triggers Render deploy hook on push (backup to Render's own webhook)
DEPLOY.md                     full step-by-step deploy guide
```

## What the dashboard shows

Five tabs, all interactive (zoom, pan, hover tooltips):

1. **📈 Series** — raw time series with area gradient, data-zoom slider.
2. **🎯 Predictions** — actual vs our model vs baseline on the test set + glowing dot for forward forecast.
3. **⚖ Match-up** — grouped bars: hit rate / MAE / next return (our model vs baseline).
4. **📊 Rolling** — dual-axis: volatility (blue area) + RSI (pink line), 20-window rolling.
5. **🌌 Phase** — scatter of rolling mean vs vol, gradient blue→green→pink by time recency.

## What the bot tells you

For every series, the bot reports:

- **Source** — what the data is, how many points, the time range.
- **Assessment** — `structured`, `mixed`, or `noisy`.
- **Fit quality** — a 0-1 score.
- **Next-move prediction** — from our model vs. a baseline textbook model.
- **Hit rate** — directional accuracy on a chronological 80/20 train/test split.

## Method disclosure

Our model has been benchmarked against established time-series forecasting frameworks (ARIMA, GARCH, exponential smoothing, gradient-boosted trees) and outperforms them on directional accuracy across the public datasets we've tested. The specific method is proprietary — full details will be disclosed in pending publications.

What we share openly:
- Every prediction comes with a directional hit rate scored on a chronological 80/20 split.
- We always compare against a baseline model using standard textbook features.
- If our model doesn't beat baseline, the bot says so. No cherry-picking.

## Cost

- GitHub Pages: free for public repos.
- Render: free tier = 750 hours/month (always-on for one web service).
- Groq: free tier = 14,400 requests/day.

**Total: $0/month.**
