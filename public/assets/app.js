// ============================================================================
// Predictor — chat UI + 5-tab ECharts dashboard, all client-side.
// ============================================================================

const $ = (id) => document.getElementById(id);

const state = {
  busy: false,
  pendingFile: null,
  history: [],
  analysis: null,
  activeTab: 'series',
  charts: {},  // tab-name -> echarts instance
};

const VERDICT_LABELS = {
  HOLDS: { text: 'structured', cls: 'ok' },
  WEAK:  { text: 'mixed',      cls: 'warn' },
  FAILS: { text: 'noisy',      cls: 'danger' },
};

// ── Utils ─────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmt(x, n = 3) {
  if (x === null || x === undefined || !Number.isFinite(Number(x))) return '—';
  return Number(x).toFixed(n);
}
function pct(x, n = 1) {
  if (x === null || x === undefined || !Number.isFinite(Number(x))) return '—';
  return (Number(x) * 100).toFixed(n) + '%';
}
function signed(x, n = 2) {
  if (x === null || x === undefined || !Number.isFinite(Number(x))) return '—';
  const v = Number(x);
  return (v > 0 ? '+' : '') + v.toFixed(n);
}
function setStatus(text, cls = '') {
  $('statusText').textContent = text;
  $('statusChip').className = 'status-chip ' + cls;
}

function renderMarkdown(text) {
  const lines = text.split('\n');
  let html = '';
  let inList = false;
  for (let i = 0; i < lines.length; i++) {
    let line = esc(lines[i]).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    if (line.startsWith('- ') || line.startsWith('* ')) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${line.slice(2)}</li>`;
      continue;
    } else if (inList) { html += '</ul>'; inList = false; }
    if (!line.trim()) { html += '<p></p>'; continue; }
    if (line.trim().startsWith('---')) continue;
    html += `<p>${line}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

function appendMsg(html, who = 'bot') {
  const messages = $('messages');
  const el = document.createElement('div');
  el.className = `msg ${who}`;
  el.innerHTML = `<div class="avatar">${who === 'bot' ? '●' : 'U'}</div><div class="bubble">${html}</div>`;
  messages.appendChild(el);
  messages.scrollTop = messages.scrollHeight;
}
function appendTyping() { return appendMsg('<div class="typing"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>', 'bot'); }
function removeTyping() {
  const t = $('messages').querySelector('.typing');
  if (t) t.closest('.msg').remove();
}

// ── Status ────────────────────────────────────────────────────────────────
function refreshStatus() {
  if (window.Groq.isConfigured()) setStatus('ready', 'ok');
  else setStatus('backend URL not set', 'err');
}

// ── Chat send ─────────────────────────────────────────────────────────────
async function send() {
  if (state.busy) return;
  const input = $('chatInput');
  const text = (input.value || '').trim();
  if (!text && !state.pendingFile) { input.focus(); return; }

  let userHtml = renderMarkdown(text);
  if (state.pendingFile) {
    userHtml += `<p class="muted">(attached: ${esc(state.pendingFile.name)}, ${state.pendingFile.size} bytes)</p>`;
  }
  appendMsg(userHtml, 'user');
  input.value = '';
  input.style.height = 'auto';

  // Capture file content (if any) then clear the pending file
  let fileContent = null, fileName = null;
  if (state.pendingFile) {
    fileName = state.pendingFile.name;
    try { fileContent = await state.pendingFile.text(); } catch (e) { /* ignore */ }
    state.pendingFile = null;
    $('dropzone').querySelector('p').innerHTML = '<b>Drop a CSV / JSON / TSV file here</b> · or click to choose';
  }

  state.busy = true;
  $('sendBtn').disabled = true;

  // Step 1: parse + analyze (always works, no Groq needed)
  let analysis = null;
  try {
    analysis = await runAnalysis(text, fileContent, fileName);
    if (analysis?.error) {
      appendMsg(`<p><b>Couldn't analyze:</b> ${esc(analysis.error)}</p>`, 'bot');
      state.busy = false;
      $('sendBtn').disabled = false;
      return;
    }
    state.analysis = analysis;
    renderDashboard();
    appendMsg(renderDashboardSummary(analysis), 'bot');
  } catch (err) {
    appendMsg(`<p><b>Error:</b> ${esc(err.message)}</p>`, 'bot');
    state.busy = false;
    $('sendBtn').disabled = false;
    return;
  }

  // Step 2: ask Groq to narrate (only if backend URL is configured)
  if (!window.Groq.isConfigured()) {
    appendMsg(`<p class="muted">Dashboard populated. To get a natural-language narrative, set <code>BACKEND_URL</code> in <code>public/assets/groq.js</code> to your deployed Render backend URL (see <code>DEPLOY.md</code>).</p>`, 'bot');
    state.history.push({ role: 'user', content: text || `(file: ${fileName})` });
    state.history.push({ role: 'assistant', content: '(dashboard only — backend URL not set)' });
    state.busy = false;
    $('sendBtn').disabled = false;
    return;
  }

  appendTyping();
  setStatus('thinking', '');
  try {
    const reply = await window.Groq.explainAnalysis(analysis, text || `(file: ${fileName})`);
    removeTyping();
    appendMsg(renderMarkdown(reply), 'bot');
    state.history.push({ role: 'user', content: text || `(file: ${fileName})` });
    state.history.push({ role: 'assistant', content: reply });
    setStatus('ready', 'ok');
  } catch (err) {
    removeTyping();
    appendMsg(`<p><b>Groq error:</b> ${esc(err.message)}</p><p class="muted">The dashboard is still populated — you can browse the charts.</p>`, 'bot');
    setStatus('Groq error', 'err');
  } finally {
    state.busy = false;
    $('sendBtn').disabled = false;
  }
}

async function runAnalysis(text, fileContent, fileName) {
  if (fileContent) {
    const lower = (fileName || '').toLowerCase();
    let parsed;
    if (lower.endsWith('.json') || fileContent.trim().startsWith('{') || fileContent.trim().startsWith('[')) {
      parsed = window.Adapters.seriesFromJSON(fileContent, fileName);
    } else {
      parsed = window.Adapters.seriesFromCSV(fileContent, fileName);
    }
    return window.Engine.analyzeSeries(parsed.points, parsed.label, parsed.unit, parsed.source);
  }
  // URL in text?
  const urlMatch = (text || '').match(/https?:\/\/[^\s<>"']+/i);
  if (urlMatch) {
    const url = urlMatch[0];
    appendMsg(`<p class="muted">Fetching ${esc(url)}…</p>`, 'bot');
    const parsed = await window.Adapters.fetchAndAdapt(url);
    return window.Engine.analyzeSeries(parsed.points, parsed.label, parsed.unit, parsed.source);
  }
  // Free chat — no analysis
  if (window.Groq.isConfigured()) {
    appendTyping();
    try {
      const reply = await window.Groq.freeChat(text || '(empty)', state.history);
      removeTyping();
      appendMsg(renderMarkdown(reply), 'bot');
      state.history.push({ role: 'user', content: text });
      state.history.push({ role: 'assistant', content: reply });
    } catch (err) {
      removeTyping();
      appendMsg(`<p><b>Groq error:</b> ${esc(err.message)}</p>`, 'bot');
    }
    return null;
  }
  appendMsg(`<p>Paste a URL or drop a file to get an analysis.</p>`, 'bot');
  return null;
}

function renderDashboardSummary(a) {
  const v = VERDICT_LABELS[a.verdict] || { text: a.verdict?.toLowerCase() || '—', cls: 'warn' };
  const ml = a.ml || {};
  const diff = (Number.isFinite(ml.model_hit_rate) && Number.isFinite(ml.baseline_hit_rate))
    ? (ml.model_hit_rate - ml.baseline_hit_rate) * 100
    : null;
  const diffStr = diff === null ? '' : (diff >= 0
    ? ` Our model beats baseline by <b>${diff.toFixed(1)} pp</b> on hit rate.`
    : ` Our model underperforms baseline by <b>${(-diff).toFixed(1)} pp</b> on hit rate.`);
  return `<p>Done. Read <b>${a.series.n_points}</b> points from <b>${esc(a.series.label || '')}</b>. Signal: <b>${esc(v.text)}</b> (fit quality ${pct(a.fit.r2, 1)}).${diffStr} Dashboard updated — check the charts on the right.</p>`;
}

// ── Dashboard rendering ───────────────────────────────────────────────────
function renderDashboard() {
  if (!state.analysis) return;
  $('dashboard').innerHTML = '<div class="chart-host" id="chartHost"></div>';
  renderActiveTab();
}

function renderActiveTab() {
  if (!state.analysis) return;
  const tab = state.activeTab;
  if (!state.charts[tab]) {
    const host = $('chartHost');
    if (host) {
      state.charts[tab] = echarts.init(host);
    }
  }
  const chart = state.charts[tab];
  if (!chart) return;
  chart.clear();

  if (tab === 'series') renderSeriesTab(chart);
  else if (tab === 'predictions') renderPredictionsTab(chart);
  else if (tab === 'matchup') renderMatchupTab(chart);
  else if (tab === 'rolling') renderRollingTab(chart);
  else if (tab === 'phase') renderPhaseTab(chart);
}

function commonChartOpts() {
  return {
    backgroundColor: 'transparent',
    textStyle: { color: '#e5e7eb', fontFamily: 'Inter, system-ui, sans-serif' },
    tooltip: { trigger: 'axis', backgroundColor: '#0b1220', borderColor: '#2d3a52', textStyle: { color: '#e5e7eb' } },
    legend: { top: 6, textStyle: { color: '#8b97ad' } },
    grid: { left: 56, right: 24, top: 38, bottom: 60 },
    xAxis: { axisLine: { lineStyle: { color: '#2d3a52' } }, axisLabel: { color: '#8b97ad' } },
    yAxis: { axisLine: { lineStyle: { color: '#2d3a52' } }, axisLabel: { color: '#8b97ad' }, splitLine: { lineStyle: { color: '#1f2937' } } },
    dataZoom: [
      { type: 'inside', start: 0, end: 100 },
      { type: 'slider', height: 18, bottom: 18, borderColor: '#2d3a52', fillerColor: 'rgba(96,165,250,0.15)', handleStyle: { color: '#60a5fa' } },
    ],
  };
}

function renderSeriesTab(chart) {
  const a = state.analysis;
  const values = a.series.values;
  const ts = a.series.timestamps;
  const data = values.map((v, i) => [ts[i] || i, v]);
  chart.setOption({
    ...commonChartOpts(),
    title: { text: 'Raw series', left: 8, top: 0, textStyle: { color: '#8b97ad', fontSize: 12, fontWeight: 500 } },
    xAxis: { ...commonChartOpts().xAxis, type: 'category' },
    yAxis: { ...commonChartOpts().yAxis, type: 'value', scale: true, name: a.series.unit || 'value', nameTextStyle: { color: '#8b97ad' } },
    series: [{
      name: a.series.label || 'value',
      type: 'line',
      data,
      showSymbol: false,
      lineStyle: { color: '#60a5fa', width: 1.6 },
      areaStyle: {
        color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [
          { offset: 0, color: 'rgba(96,165,250,0.35)' },
          { offset: 1, color: 'rgba(96,165,250,0.02)' },
        ]},
      },
    }],
  });
}

function renderPredictionsTab(chart) {
  const a = state.analysis;
  const ml = a.ml;
  if (!ml || ml.error || !ml.model_testIdx) {
    chart.setOption({ title: { text: 'No predictions available — series too short for ML', left: 'center', top: 'center', textStyle: { color: '#8b97ad' } } });
    return;
  }
  const values = a.series.values;
  // Build actual values for the test period + the forward forecast
  const testData = ml.model_testIdx.map((idx, i) => [idx + ml.horizon, values[idx + ml.horizon]]);
  const modelPredData = ml.model_testIdx.map((idx, i) => [idx + ml.horizon, values[idx] * (1 + ml.model_testPreds[i])]);
  const baselinePredData = ml.model_testIdx.map((idx, i) => [idx + ml.horizon, values[idx] * (1 + ml.baseline_testPreds[i])]);
  // Forward forecast — single point at end
  const lastIdx = values.length - 1;
  const fwdIdx = lastIdx + ml.horizon;
  const fwdValue = values[lastIdx] * (1 + ml.model_next_return);
  chart.setOption({
    ...commonChartOpts(),
    title: { text: `Predictions — test set + ${ml.horizon}-step forward forecast`, left: 8, top: 0, textStyle: { color: '#8b97ad', fontSize: 12, fontWeight: 500 } },
    xAxis: { ...commonChartOpts().xAxis, type: 'value', name: 'step', nameTextStyle: { color: '#8b97ad' } },
    yAxis: { ...commonChartOpts().yAxis, type: 'value', scale: true, name: a.series.unit || 'value', nameTextStyle: { color: '#8b97ad' } },
    series: [
      { name: 'actual', type: 'line', data: testData, showSymbol: false, lineStyle: { color: '#8fb4c4', width: 1.6 } },
      { name: 'our model', type: 'line', data: modelPredData, showSymbol: false, lineStyle: { color: '#34d399', width: 1.8, type: 'dashed' } },
      { name: 'baseline', type: 'line', data: baselinePredData, showSymbol: false, lineStyle: { color: '#ff9a4a', width: 1.4, type: 'dotted' } },
      {
        name: 'forward forecast', type: 'effectScatter', data: [[fwdIdx, fwdValue]], symbolSize: 14,
        itemStyle: { color: '#34d399', shadowBlur: 12, shadowColor: '#34d399' },
        tooltip: { formatter: () => `forward forecast (${ml.horizon} steps ahead)<br/>value: ${fmt(fwdValue, 4)}<br/>predicted return: ${pct(ml.model_next_return, 3)}` },
      },
    ],
  });
}

function renderMatchupTab(chart) {
  const a = state.analysis;
  const ml = a.ml;
  if (!ml || ml.error) {
    chart.setOption({ title: { text: 'No ML comparison available', left: 'center', top: 'center', textStyle: { color: '#8b97ad' } } });
    return;
  }
  chart.setOption({
    backgroundColor: 'transparent',
    textStyle: { color: '#e5e7eb', fontFamily: 'Inter, system-ui, sans-serif' },
    title: { text: 'Our model vs baseline', left: 8, top: 0, textStyle: { color: '#8b97ad', fontSize: 12, fontWeight: 500 } },
    tooltip: { trigger: 'axis', backgroundColor: '#0b1220', borderColor: '#2d3a52', textStyle: { color: '#e5e7eb' } },
    legend: { top: 6, textStyle: { color: '#8b97ad' } },
    grid: { left: 60, right: 30, top: 38, bottom: 30 },
    xAxis: { type: 'category', data: ['hit rate', 'MAE (lower better)', 'next return'], axisLine: { lineStyle: { color: '#2d3a52' } }, axisLabel: { color: '#8b97ad' } },
    yAxis: [
      { type: 'value', axisLine: { lineStyle: { color: '#2d3a52' } }, axisLabel: { color: '#8b97ad', formatter: (v) => (v * 100).toFixed(0) + '%' }, splitLine: { lineStyle: { color: '#1f2937' } } },
    ],
    series: [
      {
        name: 'our model', type: 'bar', data: [ml.model_hit_rate, ml.model_mae, Math.abs(ml.model_next_return)],
        itemStyle: { color: '#34d399', borderRadius: [4, 4, 0, 0] },
        label: { show: true, position: 'top', color: '#e5e7eb', formatter: (p) => p.value.toFixed(3) },
      },
      {
        name: 'baseline', type: 'bar', data: [ml.baseline_hit_rate, ml.baseline_mae, Math.abs(ml.baseline_next_return)],
        itemStyle: { color: '#ff9a4a', borderRadius: [4, 4, 0, 0] },
        label: { show: true, position: 'top', color: '#e5e7eb', formatter: (p) => p.value.toFixed(3) },
      },
    ],
  });
}

function renderRollingTab(chart) {
  const a = state.analysis;
  const rolling = (a.rolling || []).filter(Boolean);
  if (!rolling.length) {
    chart.setOption({ title: { text: 'Not enough data for rolling stats', left: 'center', top: 'center', textStyle: { color: '#8b97ad' } } });
    return;
  }
  const xData = rolling.map(r => r.i);
  chart.setOption({
    ...commonChartOpts(),
    title: { text: 'Rolling 20-window volatility & RSI', left: 8, top: 0, textStyle: { color: '#8b97ad', fontSize: 12, fontWeight: 500 } },
    xAxis: { ...commonChartOpts().xAxis, type: 'category', data: xData },
    yAxis: [
      { type: 'value', name: 'volatility', position: 'left', axisLine: { lineStyle: { color: '#60a5fa' } }, axisLabel: { color: '#60a5fa' }, splitLine: { lineStyle: { color: '#1f2937' } } },
      { type: 'value', name: 'RSI (0-100)', position: 'right', min: 0, max: 100, axisLine: { lineStyle: { color: '#f472b6' } }, axisLabel: { color: '#f472b6' }, splitLine: { show: false } },
    ],
    series: [
      { name: 'volatility', type: 'line', yAxisIndex: 0, data: rolling.map(r => r.vol), showSymbol: false, lineStyle: { color: '#60a5fa', width: 1.6 }, areaStyle: { color: 'rgba(96,165,250,0.15)' } },
      { name: 'RSI', type: 'line', yAxisIndex: 1, data: rolling.map(r => r.rsi), showSymbol: false, lineStyle: { color: '#f472b6', width: 1.4 } },
    ],
  });
}

function renderPhaseTab(chart) {
  const a = state.analysis;
  const rolling = (a.rolling || []).filter(Boolean);
  if (rolling.length < 5) {
    chart.setOption({ title: { text: 'Not enough data for phase space', left: 'center', top: 'center', textStyle: { color: '#8b97ad' } } });
    return;
  }
  // Scatter of rolling mean (x) vs rolling vol (y), colored by recency
  const data = rolling.map((r, i) => ({
    value: [r.mean, r.vol, i / rolling.length],
  }));
  chart.setOption({
    backgroundColor: 'transparent',
    textStyle: { color: '#e5e7eb', fontFamily: 'Inter, system-ui, sans-serif' },
    title: { text: 'Phase space — rolling mean vs volatility (color = time)', left: 8, top: 0, textStyle: { color: '#8b97ad', fontSize: 12, fontWeight: 500 } },
    tooltip: { trigger: 'item', backgroundColor: '#0b1220', borderColor: '#2d3a52', textStyle: { color: '#e5e7eb' }, formatter: (p) => `step ${p.data.value[2] === 0 ? '0%' : (p.data.value[2] * 100).toFixed(0) + '%'}<br/>mean: ${fmt(p.data.value[0])}<br/>vol: ${fmt(p.data.value[1])}` },
    grid: { left: 56, right: 24, top: 38, bottom: 36 },
    xAxis: { type: 'value', name: 'rolling mean', nameTextStyle: { color: '#8b97ad' }, axisLine: { lineStyle: { color: '#2d3a52' } }, axisLabel: { color: '#8b97ad' }, splitLine: { lineStyle: { color: '#1f2937' } } },
    yAxis: { type: 'value', name: 'volatility', nameTextStyle: { color: '#8b97ad' }, axisLine: { lineStyle: { color: '#2d3a52' } }, axisLabel: { color: '#8b97ad' }, splitLine: { lineStyle: { color: '#1f2937' } } },
    visualMap: {
      min: 0, max: 1, dimension: 2, show: false,
      inRange: { color: ['#60a5fa', '#34d399', '#f472b6'] },
    },
    series: [{
      type: 'scatter', data, symbolSize: 7,
      itemStyle: { opacity: 0.7 },
    }],
  });
}

// ── Dropzone + tab switching ──────────────────────────────────────────────
function wireDropzone() {
  const dz = $('dropzone');
  const fileInput = $('fileInput');
  dz.addEventListener('click', () => fileInput.click());
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) {
      state.pendingFile = e.target.files[0];
      dz.querySelector('p').innerHTML = `<b>Attached:</b> ${esc(state.pendingFile.name)} (${state.pendingFile.size} bytes)`;
    }
  });
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragover'); }));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files[0]) {
      state.pendingFile = e.dataTransfer.files[0];
      dz.querySelector('p').innerHTML = `<b>Attached:</b> ${esc(state.pendingFile.name)} (${state.pendingFile.size} bytes)`;
    }
  });
}

function wireTabs() {
  document.querySelectorAll('.dash-tab').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.dash-tab').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      state.activeTab = b.dataset.dash;
      // Reset chart container
      $('dashboard').innerHTML = '<div class="chart-host" id="chartHost"></div>';
      state.charts = {};
      renderActiveTab();
    });
  });
}

// ── Init ──────────────────────────────────────────────────────────────────
function init() {
  wireDropzone();
  wireTabs();
  $('sendBtn').addEventListener('click', send);
  $('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $('chatInput').addEventListener('input', (e) => {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(140, e.target.scrollHeight) + 'px';
  });
  window.addEventListener('resize', () => {
    Object.values(state.charts).forEach(c => c && c.resize());
  });
  refreshStatus();
}

init();
