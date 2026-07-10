// ============================================================================
// Groq caller — uses the shared Render.com backend by default.
// The backend holds the GROQ_API_KEY as an env var, so visitors don't need
// their own key. Set BACKEND_URL below to your deployed Render URL.
// ============================================================================

window.Groq = (function () {

// ============================================================================
// SET THIS to your deployed Render backend URL.
// Get it from your Render dashboard after deploying (see DEPLOY.md).
// Example: 'https://predictor-backend-xyz.onrender.com'
// ============================================================================
const BACKEND_URL = 'https://universal-ml-predictor.onrender.com';  // ← paste your Render URL here

function isConfigured() {
  return !!BACKEND_URL;
}

async function callBackend(payload) {
  if (!BACKEND_URL) throw new Error('Backend URL not set. Edit public/assets/groq.js and set BACKEND_URL to your deployed Render URL. See DEPLOY.md.');
  
  // 30s timeout — Render free tier takes ~20s to wake from sleep
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  
  let r;
  try {
    r = await fetch(BACKEND_URL + '/groq-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Backend timed out (30s). Render free tier may be waking up — try again in a moment.');
    // Network error — likely cold start connection drop. Retry once.
    try {
      r = await fetch(BACKEND_URL + '/groq-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err2) {
      throw new Error('Cannot reach backend. It may be waking up from sleep — try again in 10 seconds. (' + err2.message + ')');
    }
  } finally {
    clearTimeout(timeout);
  }
  if (!r.ok) {
    const errText = await r.text();
    let msg = `Backend HTTP ${r.status}`;
    try { const j = JSON.parse(errText); msg += `: ${j.error || errText.slice(0, 200)}`; } catch { msg += `: ${errText.slice(0, 200)}`; }
    throw new Error(msg);
  }
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.reply || '(no reply)';
}

async function explainAnalysis(analysis, userMessage) {
  return callBackend({
    mode: 'explain',
    message: userMessage,
    analysis,
  });
}

async function freeChat(userMessage, history) {
  return callBackend({
    mode: 'free',
    message: userMessage,
    history: history.slice(-10),
  });
}

return { isConfigured, explainAnalysis, freeChat };
})();
