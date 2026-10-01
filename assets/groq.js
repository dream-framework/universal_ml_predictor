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
const BACKEND_URL = 'https://universal-ml-predictor.onrender.com';

function isConfigured() {
  return !!BACKEND_URL;
}

async function callBackend(payload) {
  if (!BACKEND_URL) throw new Error('Backend URL not set. Edit public/assets/groq.js and set BACKEND_URL to your deployed Render URL. See DEPLOY.md.');

  // 30s timeout — Render free tier takes ~20s to wake from sleep
  const attempt = async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const r = await fetch(BACKEND_URL + '/groq-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!r.ok) {
        const errText = await r.text();
        let msg = `Backend HTTP ${r.status}`;
        try { const j = JSON.parse(errText); msg += `: ${j.error || errText.slice(0, 200)}`; } catch { msg += `: ${errText.slice(0, 200)}`; }
        throw new Error(msg);
      }
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      return j.reply || '(no reply)';
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') throw new Error('Backend timed out (30s). Render free tier may be waking up — try again in a moment.');
      throw err;
    }
  };

  // Try once, then retry once on network error (cold start connection drop)
  try {
    return await attempt();
  } catch (err) {
    if (err.message.includes('timed out') || err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
      // Retry once after a short delay
      await new Promise(r => setTimeout(r, 2000));
      return await attempt();
    }
    throw err;
  }
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

return { isConfigured, explainAnalysis, freeChat, _backendUrl: () => BACKEND_URL, _backendUrlRaw: BACKEND_URL };
})();
