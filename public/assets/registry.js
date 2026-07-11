// ============================================================================
// GitHub-backed results registry.
// Saves each analysis as a JSON file in a GitHub repo via the Contents API.
// User provides a fine-grained PAT (contents:write) stored in localStorage.
// Exposed as window.Registry.
// ============================================================================

window.Registry = (function () {

const KEYS = {
  repo: 'predictor_reg_repo',
  token: 'predictor_reg_token',
  branch: 'predictor_reg_branch',
};
const DEFAULT_BRANCH = 'main';
const API = 'https://api.github.com';

function getRepo() { return localStorage.getItem(KEYS.repo) || ''; }
function getToken() { return localStorage.getItem(KEYS.token) || ''; }
function getBranch() { return localStorage.getItem(KEYS.branch) || DEFAULT_BRANCH; }
function setRepo(v) { localStorage.setItem(KEYS.repo, v); }
function setToken(v) { localStorage.setItem(KEYS.token, v); }
function setBranch(v) { localStorage.setItem(KEYS.branch, v); }
function isConfigured() { return !!getRepo() && !!getToken(); }

function statusEl() { return document.getElementById('registryStatus'); }
function refreshStatus() {
  const el = statusEl();
  if (!el) return;
  if (isConfigured()) {
    el.textContent = 'registry: ' + getRepo();
    el.className = 'registry-status ok';
  } else {
    el.textContent = 'registry: not configured';
    el.className = 'registry-status';
  }
}

// ── List all saved analyses in the repo ───────────────────────────────────
async function list() {
  if (!isConfigured()) return [];
  const repo = getRepo();
  const branch = encodeURIComponent(getBranch());
  const r = await fetch(`${API}/repos/${repo}/contents/results?ref=${branch}`, {
    headers: {
      'Authorization': `Bearer ${getToken()}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (r.status === 404) return [];  // results/ folder doesn't exist yet
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(`GitHub API ${r.status}: ${err.message || r.statusText}`);
  }
  const items = await r.json();
  // items is an array of {name, path, sha, download_url, ...}
  // Filter to .json files, sorted by name (newest first since names are timestamped)
  return items
    .filter(it => it.name.endsWith('.json'))
    .sort((a, b) => b.name.localeCompare(a.name));
}

// ── Fetch one analysis by path ────────────────────────────────────────────
async function load(item) {
  const r = await fetch(item.download_url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status} loading ${item.name}`);
  return await r.json();
}

// ── Save current analysis ─────────────────────────────────────────────────
async function save(analysis, userMessage) {
  if (!isConfigured()) throw new Error('Registry not configured. Click "Save to registry" → settings.');
  const repo = getRepo();
  const branch = getBranch();
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);  // 2026-07-10T23-45-12
  const path = `results/${ts}.json`;
  const payload = {
    saved_at: now.toISOString(),
    user_message: userMessage || '',
    analysis,
  };
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(payload, null, 2))));
  const r = await fetch(`${API}/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${getToken()}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: `analysis: ${analysis?.series?.label || ts}`,
      content,
      branch,
    }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(`GitHub API ${r.status}: ${err.message || r.statusText}`);
  }
  return { path, ts };
}

// ── Delete one analysis ───────────────────────────────────────────────────
async function remove(item) {
  if (!isConfigured()) throw new Error('Registry not configured.');
  const repo = getRepo();
  const branch = getBranch();
  const r = await fetch(`${API}/repos/${repo}/contents/${item.path}?ref=${encodeURIComponent(branch)}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${getToken()}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: `delete: ${item.name}`,
      sha: item.sha,
      branch,
    }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(`GitHub API ${r.status}: ${err.message || r.statusText}`);
  }
}

return {
  isConfigured, refreshStatus,
  getRepo, getToken, getBranch,
  setRepo, setToken, setBranch,
  list, load, save, remove,
};
})();
