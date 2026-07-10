// ============================================================================
// Minimal Express server — the only server-side code.
// Holds the shared GROQ_API_KEY as an env var (set on Render, never in repo)
// and proxies /groq-chat to api.groq.com.
//
// Everything else (analysis engine, charts, dashboard) runs in the browser
// on GitHub Pages. This server is just a 60-line Groq proxy.
// ============================================================================

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

// Per-IP rate limit (in-memory, resets on redeploy).
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

app.use(express.json({ limit: '1mb' }));

// Health check — Render pings this to know the service is up
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'predictor-groq-proxy',
    groq_configured: !!process.env.GROQ_API_KEY,
  });
});

// Main endpoint — proxied from the Pages site
app.post('/groq-chat', async (req, res) => {
  // CORS — allow your Pages site (and localhost for dev)
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || 'unknown';
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Rate limit: 5 requests per minute. Try again shortly.' });
  }

  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ error: 'GROQ_API_KEY not set on server. Set it in Render → Environment.' });
  }

  try {
    const { message, analysis, history, mode, model } = req.body || {};

    const systemPrompt = `You are the Predictor bot. You analyze time series and explain what you see in plain English.

When the system gives you an analysis payload, it contains:
- The source series (label, number of points, latest timestamp, unit)
- A fit-quality score (fit.r2) between 0 and 1
- A verdict: 'HOLDS' (structured), 'WEAK' (mixed), or 'FAILS' (noisy)
  — use the words 'structured', 'mixed', or 'noisy' instead of the codes
- An ML prediction comparing OUR MODEL against a BASELINE model

HOW TO EXPLAIN:
1. Start with what the data is.
2. Translate the verdict into plain English.
3. Mention the ML prediction honestly. If our model didn't beat baseline, say so.
4. End with: this is a structural diagnostic, not a guaranteed forecast.

RULES:
- Keep replies to 3-5 short paragraphs. No equations.
- NEVER mention S2, stretched exponential, retention curve, D, lambda, λq, or any internal parameter name.
- If asked about the method: "Our model has been benchmarked against established forecasting frameworks (ARIMA, GARCH, exponential smoothing, gradient-boosted trees) and outperforms them on directional accuracy. The specific method is proprietary pending publication."
- Never invent numbers — only cite values in the analysis payload.
- If the data is too short, say so and ask for more.`;

    let messages;
    if (mode === 'free') {
      messages = [
        { role: 'system', content: systemPrompt + '\n\nThe user has not provided data yet. Answer conversationally. If they want analysis, ask them to paste a URL or upload a file. Stay in plain English. Never mention S2, DREAM, stretched exponential, retention curve, or any proprietary method name.' },
        ...(history || []).slice(-10).map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: message || '(empty)' },
      ];
    } else {
      messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `The user said: "${message || ''}"\n\nI fetched and analyzed their data. Here are the results:\n\n${JSON.stringify(analysis, null, 2)}\n\nExplain these results to the user in plain English. Be specific about the numbers. Use the words 'structured', 'mixed', or 'noisy' — never the internal codes. If our model beats baseline, mention it. If not, mention that honestly. Never mention S2, stretched exponential, retention curve, D, or lambda.` },
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
        temperature: 0.4,
        max_tokens: 800,
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

app.listen(PORT, () => {
  console.log(`Predictor backend on :${PORT}`);
  console.log(`  Groq: ${process.env.GROQ_API_KEY ? 'configured' : 'NOT configured (set GROQ_API_KEY on Render)'}`);
});
