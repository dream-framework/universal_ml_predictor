// ============================================================================
// Predictor backend — minimal Express proxy for Groq.
// Holds the shared GROQ_API_KEY as an env var (set on Render, never in repo)
// and proxies /groq-chat requests from the GitHub Pages site to api.groq.com.
// ============================================================================

const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

// ── Per-IP rate limit (in-memory, resets on redeploy) ─────────────────────
// Groq free tier = 30 req/min global, 14k/day. 5/min/IP is generous + safe.
const RATE_LIMIT = { windowMs: 60_000, max: 5 };
const ipHits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter(h => now - h.ts < RATE_LIMIT.windowMs);
  if (hits.length >= RATE_LIMIT.max) return true;
  hits.push({ ts: now });
  ipHits.set(ip, hits);
  return false;
}

// ── Middleware ────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));

// CORS for ALL routes — set headers on every response, including errors.
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  // Handle preflight here so OPTIONS never falls through to 404
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ── Health check ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'predictor-groq-proxy',
    groq_configured: !!process.env.GROQ_API_KEY,
  });
});

// ── Fetch proxy ───────────────────────────────────────────────────────────
// Some sources (Yahoo Finance, etc.) block browser fetches via CORS or
// require a User-Agent. The browser calls this endpoint with ?url=...;
// we fetch server-side with a real UA and return the body with CORS headers.
//
// Fallback chain: direct fetch → allorigins.win proxy → give up.
app.get('/fetch-proxy', async (req, res) => {
  let url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing ?url= parameter' });
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'URL must start with http:// or https://' });

  // Yahoo Finance: query1 is heavily rate-limited; query2 usually works.
  url = url.replace('query1.finance.yahoo.com', 'query2.finance.yahoo.com');

  const fetchOpts = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json,text/csv,text/plain,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  };

  // Tier 1: direct fetch
  try {
    const r = await fetch(url, fetchOpts);
    if (r.ok) {
      const text = await r.text();
      const ct = r.headers.get('content-type') || 'text/plain';
      res.set('Content-Type', ct);
      return res.send(text);
    }
    // 429/403/etc — fall through to tier 2
  } catch (e) {
    // network error — fall through to tier 2
  }

  // Tier 2: try multiple free CORS proxies in sequence.
  // allorigins is flaky (~50% success per attempt), so retry + try alternatives.
  const proxies = [
    (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
    (u) => 'https://api.codetabs.com/v1/proxy/?quest=' + encodeURIComponent(u),
    (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
  ];
  for (let pi = 0; pi < proxies.length; pi++) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const proxyUrl = proxies[pi](url);
        const r = await fetch(proxyUrl, { redirect: 'follow' });
        if (r.ok) {
          const text = await r.text();
          if (text && text.length > 20 && !text.includes('500 Internal Server Error') && !text.includes('error code: 5') && !text.includes('Request Timeout')) {
            let ct = 'text/plain';
            if (url.endsWith('.json') || url.includes('/chart/') || text.trim().startsWith('{') || text.trim().startsWith('[')) ct = 'application/json';
            else if (url.endsWith('.csv') || url.endsWith('.tsv') || text.includes(',')) ct = 'text/csv';
            res.set('Content-Type', ct);
            return res.send(text);
          }
        }
      } catch (e) { /* try next */ }
      if (attempt < 2) await new Promise(r => setTimeout(r, 300 * attempt));
    }
  }

  return res.status(502).json({ error: `Could not fetch ${url} via direct or any CORS proxy (allorigins, codetabs, corsproxy.io all failed). The source may be down or blocking.` });
});

// ── Main endpoint ─────────────────────────────────────────────────────────
app.post('/groq-chat', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || 'unknown';
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Rate limit: 5 requests per minute. Try again shortly.' });
  }

  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ error: 'GROQ_API_KEY not set on server. Set it in Render → Environment.' });
  }

  try {
    const { message, analysis, history, mode, model } = req.body || {};

    const systemPrompt = `You are the Predictor bot. You analyze time series and explain what you see in plain English — DETAILED but LACONIC.

PAYLOAD FIELDS:
- series: label, source, n_points, latest_t, unit, first_value, last_value
- fit.r2: 0-1 score, higher = more predictable structure
- verdict: HOLDS (structured), WEAK (mixed), FAILS (noisy)
- ml: model_*/baseline_* for hit_rate, next_return, mae; n_test, n_train

STYLE — DETAILED BUT LACONIC:
- Aim for 4-6 sentences total, split across 2 short paragraphs.
- Every sentence must carry information. No filler, no preamble, no "Let me explain", no "Based on the analysis", no "It's worth noting".
- Cut every word that isn't load-bearing. "The signal appears to be somewhat structured" → "Signal is structured."
- Cover: (1) what the data is — USE series.label AND series.source to name it specifically (e.g. "GOES X-ray flux from NOAA SWPC", not "the data"); (2) the structural assessment with the fit-quality number; (3) what that means in practice (durable vs fragile, predictable vs noisy); (4) the ML prediction with both hit rates; (5) whether our model beats baseline and by how much; (6) one honest caveat if relevant.
- Use 'structured', 'mixed', or 'noisy' — never the codes HOLDS/WEAK/FAILS.
- Numbers stay specific: "66% hit rate vs 65% baseline" not "slightly better than baseline".
- No equations. No jargon. No "structural diagnostic" boilerplate.
- NEVER mention S2, stretched exponential, retention curve, D, lambda, λq.
- If asked about the method: "Benchmarked against ARIMA/GARCH/gradient-boosted trees; method is proprietary pending publication."
- If data is too short: "Need at least 30 points — got N."
- Only cite numbers from the payload. Never invent.`;

    let messages;
    if (mode === 'free') {
      messages = [
        { role: 'system', content: systemPrompt + '\n\nUser has not provided data. Answer TERSELY (max 2 sentences). If they want analysis, ask for a URL or file. Plain English. Never mention S2, DREAM, stretched exponential, retention curve, or any proprietary method name.' },
        ...(history || []).slice(-10).map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: message || '(empty)' },
      ];
    } else {
      // Build a SLIM summary for Groq — don't send raw arrays (they blow past the
      // 12k TPM free-tier limit). Groq only needs the summary numbers to write
      // its explanation; the full arrays stay in the browser for charts.
      const s = analysis?.series || {};
      const ml = analysis?.ml || {};
      const reg = ml.regression || {};
      const cls = ml.classification || {};

      // Build classification summary (just model names + accuracies + next pred)
      const clsSummary = cls.error ? { error: cls.error } : {
        n_test: cls.n_test,
        n_train: cls.n_train,
        models: cls.models ? {
          logistic: { accuracy: cls.models.logistic?.accuracy },
          knn: { accuracy: cls.models.knn?.accuracy },
          naive_bayes: { accuracy: cls.models.naive_bayes?.accuracy },
          majority: { accuracy: cls.models.majority?.accuracy, majority_class: ['DOWN','FLAT','UP'][cls.models.majority?.majority_class ?? 1] },
        } : null,
        next_prediction: cls.models?.next_prediction,
      };

      const slim = {
        series: {
          label: s.label,
          source: s.source,
          n_points: s.n_points,
          latest_t: s.latest_t,
          unit: s.unit,
          first_value: s.first_value,
          last_value: s.last_value,
        },
        fit: analysis?.fit,
        verdict: analysis?.verdict,
        ml: {
          horizon: ml.horizon,
          regression: reg.error ? { error: reg.error } : {
            ridge_s2: { hit_rate: reg.ridge_s2?.hit_rate, next_return: reg.ridge_s2?.next_return },
            ridge_baseline: { hit_rate: reg.ridge_baseline?.hit_rate },
            knn: { hit_rate: reg.knn?.hit_rate },
            mean: { hit_rate: reg.mean?.hit_rate },
            n_test: reg.n_test,
            n_train: reg.n_train,
          },
          classification: clsSummary,
        },
      };
      messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `The user said: "${message || ''}"\n\nI fetched and analyzed their data. Here are the results:\n\n${JSON.stringify(slim, null, 2)}\n\nExplain these results to the user in plain English. Be specific about the numbers. Use the words 'structured', 'mixed', or 'noisy' — never the internal codes. Cover BOTH regression (hit rates — how often the predicted direction matches the actual direction) AND classification (accuracy — how often the model correctly predicts UP/DOWN/FLAT). Name the best-performing model in each category. If no model beats the baseline, say so honestly. Never mention S2, stretched exponential, retention curve, D, or lambda.` },
      ];
    }

    const groqResp = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        messages,
        temperature: 0.3,
        max_tokens: 450,
      }),
    });

    if (!groqResp.ok) {
      const errText = await groqResp.text();
      let msg = `Groq API HTTP ${groqResp.status}`;
      try { const j = JSON.parse(errText); msg += `: ${j.error?.message || errText.slice(0, 200)}`; } catch { msg += `: ${errText.slice(0, 200)}`; }
      return res.status(502).json({ error: msg });
    }

    const groqJson = await groqResp.json();
    const reply = groqJson.choices[0]?.message?.content || '(no reply)';
    res.json({ reply });
  } catch (err) {
    console.error('[/groq-chat] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Predictor backend on :${PORT}`);
  console.log(`  Groq: ${process.env.GROQ_API_KEY ? 'configured' : 'NOT configured (set GROQ_API_KEY on Render)'}`);
});
