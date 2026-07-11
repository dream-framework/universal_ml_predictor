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
  charts: {},  // tab-name -> echarts instance (dashboard)
  fsChart: null,  // fullscreen chart instance
  feeds: [],  // loaded from feeds.json
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
  const feedLabel = state.pendingFeedLabel;
  state.pendingFeedLabel = null;  // clear after capture
  try {
    analysis = await runAnalysis(text, fileContent, fileName, feedLabel);
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

async function runAnalysis(text, fileContent, fileName, feedLabel) {
  if (fileContent) {
    const lower = (fileName || '').toLowerCase();
    let parsed;
    if (lower.endsWith('.json') || fileContent.trim().startsWith('{') || fileContent.trim().startsWith('[')) {
      parsed = window.Adapters.seriesFromJSON(fileContent, feedLabel || fileName);
    } else {
      parsed = window.Adapters.seriesFromCSV(fileContent, feedLabel || fileName);
    }
    return window.Engine.analyzeSeries(parsed.points, parsed.label, parsed.unit, parsed.source);
  }
  // URL in text?
  const urlMatch = (text || '').match(/https?:\/\/[^\s<>"']+/i);
  if (urlMatch) {
    const url = urlMatch[0];
    const label = feedLabel || url;  // use feed label if available, else URL
    appendMsg(`<p class="muted">Fetching ${esc(label === url ? url : label)}…</p>`, 'bot');
    const parsed = await window.Adapters.fetchAndAdapt(url, label);
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

function commonChartOpts(includeZoom = true) {
  const opts = {
    backgroundColor: 'transparent',
    textStyle: { color: '#e5e7eb', fontFamily: 'Inter, system-ui, sans-serif' },
    tooltip: { trigger: 'axis', backgroundColor: '#0b1220', borderColor: '#2d3a52', textStyle: { color: '#e5e7eb' } },
    legend: { top: 6, textStyle: { color: '#8b97ad' } },
    grid: { left: 56, right: 24, top: 38, bottom: 60 },
    xAxis: { axisLine: { lineStyle: { color: '#2d3a52' } }, axisLabel: { color: '#8b97ad' } },
    yAxis: { axisLine: { lineStyle: { color: '#2d3a52' } }, axisLabel: { color: '#8b97ad' }, splitLine: { lineStyle: { color: '#1f2937' } } },
    toolbox: {
      right: 12,
      top: 4,
      itemSize: 15,
      itemGap: 12,
      showTitle: false,  // hide text labels until hover
      // Glass look: almost invisible by default, pops on hover
      iconStyle: {
        borderColor: 'rgba(139,151,173,0.18)',
        borderWidth: 1,
        color: 'transparent',
        borderType: 'solid',
      },
      emphasis: {
        iconStyle: {
          borderColor: '#60a5fa',
          borderWidth: 1.4,
          color: 'rgba(96,165,250,0.12)',
          shadowBlur: 6,
          shadowColor: 'rgba(96,165,250,0.4)',
        },
      },
      feature: {
        dataZoom: { yAxisIndex: 'none', title: { zoom: 'Zoom in (drag to select)', back: 'Zoom back out' } },
        restore: { title: 'Reset zoom' },
        saveAsImage: { title: 'Save as PNG', name: 'predictor-chart', pixelRatio: 2 },
        myFullscreen: {
          show: true,
          title: 'Fullscreen',
          icon: 'path://M3,3 L9,3 L9,5 L5,5 L5,9 L3,9 Z M15,3 L21,3 L21,9 L19,9 L19,5 L15,5 Z M21,15 L21,21 L15,21 L15,19 L19,19 L19,15 Z M9,21 L3,21 L3,15 L5,15 L5,19 L9,19 Z',
          onclick: function () { toggleFullscreen(); },
        },
      },
    },
  };
  if (includeZoom) {
    opts.dataZoom = [
      { type: 'inside', start: 0, end: 100, filterMode: 'none' },
      { type: 'slider', height: 18, bottom: 18, borderColor: '#2d3a52', fillerColor: 'rgba(96,165,250,0.15)', handleStyle: { color: '#60a5fa' }, filterMode: 'none' },
    ];
  }
  return opts;
}

// ── Fullscreen overlay (separate chart instance, no DOM moving) ───────────
let _isFullscreen = false;
function ensureFsOverlay() {
  let overlay = $('fsOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'fsOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#07091a;display:none;padding:24px;';
    overlay.innerHTML = `
      <div id="fsChartHost" style="width:100%;height:100%;"></div>
      <button id="fsExit" type="button" title="Exit fullscreen (Esc)" style="position:fixed;bottom:16px;right:16px;z-index:10000;background:rgba(11,18,32,0.7);color:#8b97ad;border:1px solid #2d3a52;padding:6px 10px;border-radius:8px;cursor:pointer;font-family:inherit;font-size:12px;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);transition:all 0.15s;">×</button>
      <div id="fsTabs" style="position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:10000;display:flex;gap:4px;background:rgba(11,18,32,0.7);padding:6px;border-radius:10px;border:1px solid #2d3a52;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);"></div>
    `;
    document.body.appendChild(overlay);
    $('fsExit').onclick = () => toggleFullscreen();
    $('fsExit').onmouseenter = (e) => { e.target.style.color = '#60a5fa'; e.target.style.borderColor = '#60a5fa'; };
    $('fsExit').onmouseleave = (e) => { e.target.style.color = '#8b97ad'; e.target.style.borderColor = '#2d3a52'; };
    // Build tab buttons in the overlay (mirrors dashboard tabs)
    const tabs = [
      ['series', '📈 Series'],
      ['predictions', '🎯 Predictions'],
      ['matchup', '⚖ Match-up'],
      ['rolling', '📊 Rolling'],
      ['phase', '🌌 Phase'],
    ];
    const fsTabs = $('fsTabs');
    tabs.forEach(([key, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.fstab = key;
      b.textContent = label;
      b.style.cssText = 'background:transparent;color:#8b97ad;border:none;padding:6px 10px;cursor:pointer;font-size:12px;font-family:inherit;border-radius:6px;';
      b.onclick = () => {
        state.activeTab = key;
        // Sync the dashboard tabs too (so when we exit, dashboard shows the same tab)
        document.querySelectorAll('.dash-tab').forEach(t => t.classList.toggle('active', t.dataset.dash === key));
        renderActiveTab();
        renderFsTab();
      };
      fsTabs.appendChild(b);
    });
  }
  return overlay;
}

function renderFsTab() {
  if (!_isFullscreen) return;
  if (!state.analysis) return;
  if (!state.fsChart) state.fsChart = echarts.init($('fsChartHost'));
  state.fsChart.clear();
  const tab = state.activeTab;
  // Reuse the same render functions but with the fs chart instance
  if (tab === 'series') renderSeriesTab(state.fsChart);
  else if (tab === 'predictions') renderPredictionsTab(state.fsChart);
  else if (tab === 'matchup') renderMatchupTab(state.fsChart);
  else if (tab === 'rolling') renderRollingTab(state.fsChart);
  else if (tab === 'phase') renderPhaseTab(state.fsChart);
  // Highlight the active tab button
  document.querySelectorAll('#fsTabs button').forEach(b => {
    const active = b.dataset.fstab === tab;
    b.style.color = active ? '#60a5fa' : '#8b97ad';
    b.style.background = active ? 'rgba(96,165,250,0.15)' : 'transparent';
  });
}

function toggleFullscreen() {
  const overlay = ensureFsOverlay();
  if (!_isFullscreen) {
    if (!state.analysis) return;  // nothing to show
    overlay.style.display = 'block';
    _isFullscreen = true;
    renderFsTab();
    setTimeout(() => { if (state.fsChart) state.fsChart.resize(); }, 60);
  } else {
    overlay.style.display = 'none';
    _isFullscreen = false;
  }
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
    ...commonChartOpts(true),
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
  if (!ml || (ml.regression?.error && ml.classification?.error)) {
    chart.setOption({ title: { text: 'No ML comparison available', left: 'center', top: 'center', textStyle: { color: '#8b97ad' } } });
    return;
  }

  // Build a multi-model comparison table.
  // Regression: hit_rate for each model
  // Classification: accuracy for each model
  const regModels = ml.regression && !ml.regression.error ? [
    { name: 'Ridge (our features)', hit: ml.regression.ridge_s2?.hit_rate, mae: ml.regression.ridge_s2?.mae, color: '#34d399' },
    { name: 'Ridge (baseline feats)', hit: ml.regression.ridge_baseline?.hit_rate, mae: ml.regression.ridge_baseline?.mae, color: '#ff9a4a' },
    { name: 'kNN (k=5)', hit: ml.regression.knn?.hit_rate, mae: ml.regression.knn?.mae, color: '#60a5fa' },
    { name: 'Mean baseline', hit: ml.regression.mean?.hit_rate, mae: ml.regression.mean?.mae, color: '#8b97ad' },
  ].filter(m => m.hit != null) : [];

  const clsModels = ml.classification && !ml.classification.error ? [
    { name: 'Logistic', acc: ml.classification.models?.logistic?.accuracy, color: '#34d399' },
    { name: 'kNN', acc: ml.classification.models?.knn?.accuracy, color: '#60a5fa' },
    { name: 'Naive Bayes', acc: ml.classification.models?.naive_bayes?.accuracy, color: '#f472b6' },
    { name: 'Majority', acc: ml.classification.models?.majority?.accuracy, color: '#8b97ad' },
  ].filter(m => m.acc != null) : [];

  // Combine: show regression hit rates and classification accuracies side by side
  const allModels = [
    ...regModels.map(m => ({ name: m.name + ' (reg)', value: m.hit, color: m.color, metric: 'hit rate' })),
    ...clsModels.map(m => ({ name: m.name + ' (cls)', value: m.acc, color: m.color, metric: 'accuracy' })),
  ];

  if (!allModels.length) {
    chart.setOption({ title: { text: 'No ML models could be trained on this data', left: 'center', top: 'center', textStyle: { color: '#8b97ad' } } });
    return;
  }

  chart.setOption({
    ...commonChartOpts(false),
    title: { text: 'All models — regression hit rate & classification accuracy', left: 8, top: 0, textStyle: { color: '#8b97ad', fontSize: 12, fontWeight: 500 } },
    grid: { left: 100, right: 30, top: 38, bottom: 30 },
    xAxis: { type: 'value', axisLine: { lineStyle: { color: '#2d3a52' } }, axisLabel: { color: '#8b97ad', formatter: (v) => (v * 100).toFixed(0) + '%' }, splitLine: { lineStyle: { color: '#1f2937' } }, max: 1 },
    yAxis: { type: 'category', data: allModels.map(m => m.name).reverse(), axisLine: { lineStyle: { color: '#2d3a52' } }, axisLabel: { color: '#8b97ad', fontSize: 11 } },
    series: [{
      type: 'bar',
      data: allModels.map(m => ({ value: m.value, itemStyle: { color: m.color, borderRadius: [0, 4, 4, 0] } })).reverse(),
      label: { show: true, position: 'right', color: '#e5e7eb', formatter: (p) => (p.value * 100).toFixed(1) + '%' },
    }],
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
    ...commonChartOpts(false),
    title: { text: 'Phase space — rolling mean vs volatility (color = time)', left: 8, top: 0, textStyle: { color: '#8b97ad', fontSize: 12, fontWeight: 500 } },
    tooltip: { trigger: 'item', backgroundColor: '#0b1220', borderColor: '#2d3a52', textStyle: { color: '#e5e7eb' }, formatter: (p) => `step ${p.data.value[2] === 0 ? '0%' : (p.data.value[2] * 100).toFixed(0) + '%'}<br/>mean: ${fmt(p.data.value[0])}<br/>vol: ${fmt(p.data.value[1])}` },
    grid: { left: 56, right: 80, top: 38, bottom: 60 },
    xAxis: { type: 'value', name: 'rolling mean', nameTextStyle: { color: '#8b97ad' }, axisLine: { lineStyle: { color: '#2d3a52' } }, axisLabel: { color: '#8b97ad' }, splitLine: { lineStyle: { color: '#1f2937' } }, scale: true },
    yAxis: { type: 'value', name: 'volatility', nameTextStyle: { color: '#8b97ad' }, axisLine: { lineStyle: { color: '#2d3a52' } }, axisLabel: { color: '#8b97ad' }, splitLine: { lineStyle: { color: '#1f2937' } }, scale: true },
    // Scatter needs both-axis zoom — dots cluster on X and Y independently
    dataZoom: [
      { type: 'inside', xAxisIndex: 0, filterMode: 'none' },
      { type: 'inside', yAxisIndex: 0, filterMode: 'none' },
      { type: 'slider', xAxisIndex: 0, height: 16, bottom: 18, borderColor: '#2d3a52', fillerColor: 'rgba(96,165,250,0.15)', handleStyle: { color: '#60a5fa' } },
      { type: 'slider', yAxisIndex: 0, width: 16, right: 24, borderColor: '#2d3a52', fillerColor: 'rgba(96,165,250,0.15)', handleStyle: { color: '#60a5fa' } },
    ],
    visualMap: {
      min: 0, max: 1, dimension: 2, show: false,
      inRange: { color: ['#60a5fa', '#34d399', '#f472b6'] },
    },
    series: [{
      type: 'scatter', data, symbolSize: 7,
      itemStyle: { opacity: 0.7 },
      emphasis: { scale: 1.8, itemStyle: { borderColor: '#fff', borderWidth: 1 } },
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

// ── Reset chat + dashboard ────────────────────────────────────────────────
function resetChat() {
  if (!confirm('Reset chat and dashboard? Current analysis will be cleared.')) return;
  state.history = [];
  state.analysis = null;
  state.activeTab = 'series';
  state.charts = {};
  if (state.fsChart) { state.fsChart.clear(); }
  // Restore welcome message
  $('messages').innerHTML = `
    <div class="msg bot">
      <div class="avatar">●</div>
      <div class="bubble">
        <p>Hi! Paste a link to a CSV or JSON file, or drop one in the box below. I'll read it, run the analysis, and the dashboard on the right will light up.</p>
        <p>Good examples to try:</p>
        <ul>
          <li><code>https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_month.geojson</code> — global earthquakes, hourly counts, 30 days</li>
          <li><code>https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=365&interval=daily</code> — BTC daily closes, 1 year</li>
          <li><code>https://fred.stlouisfed.org/graph/fredgraph.csv?id=DEXUSEU</code> — USD/EUR exchange rate, ~20 years daily</li>
          <li>Any CSV with a date column and a numeric column</li>
        </ul>
        <p class="muted">The bot uses a shared key on the backend — just paste a URL or drop a file to get started.</p>
      </div>
    </div>`;
  // Reset dashboard tabs to Series
  document.querySelectorAll('.dash-tab').forEach(t => t.classList.toggle('active', t.dataset.dash === 'series'));
  // Clear dashboard
  $('dashboard').innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">📊</div>
      <p>No data yet. Paste a URL or drop a file to populate the dashboard.</p>
    </div>`;
  $('chatInput').value = '';
  $('chatInput').style.height = 'auto';
  $('chatInput').focus();
}

// ── Save current analysis to GitHub registry ──────────────────────────────
async function saveToRegistry() {
  if (!state.analysis) {
    appendMsg(`<p class="muted">Run an analysis first — nothing to save yet.</p>`, 'bot');
    return;
  }
  if (!window.Registry.isConfigured()) {
    openRegistryModal();
    return;
  }
  try {
    $('saveBtn').disabled = true;
    $('saveBtn').textContent = '⤓ Saving…';
    const userMsg = state.history.filter(h => h.role === 'user').slice(-1)[0]?.content || '';
    const result = await window.Registry.save(state.analysis, userMsg);
    appendMsg(`<p class="muted">Saved to registry: <code>${esc(result.path)}</code></p>`, 'bot');
  } catch (err) {
    appendMsg(`<p><b>Save failed:</b> ${esc(err.message)}</p>`, 'bot');
  } finally {
    $('saveBtn').disabled = false;
    $('saveBtn').textContent = '⤓ Save to registry';
  }
}

// ── History modal ─────────────────────────────────────────────────────────
async function openHistoryModal() {
  $('historyModal').classList.add('show');
  $('historyList').innerHTML = '<div class="empty">Loading…</div>';
  if (!window.Registry.isConfigured()) {
    $('historyList').innerHTML = '<div class="empty">Registry not configured. Click "Save to registry" to set it up.</div>';
    return;
  }
  try {
    const items = await window.Registry.list();
    if (!items.length) {
      $('historyList').innerHTML = '<div class="empty">No saved analyses yet. Run an analysis, then click "Save to registry".</div>';
      return;
    }
    $('historyList').innerHTML = items.map(item => {
      const ts = item.name.replace('.json', '').replace(/-/g, (m, i) => i > 9 ? (i === 10 ? 'T' : ':') : '-');
      return `
        <div class="history-item" data-path="${esc(item.path)}" data-sha="${esc(item.sha)}">
          <div class="h-meta">
            <div class="h-title">${esc(item.name)}</div>
            <div class="h-sub">${esc(item.path)}</div>
          </div>
          <div class="h-stats">
            <div class="h-stat"><span>size</span><b>${(item.size / 1024).toFixed(1)} KB</b></div>
          </div>
          <button class="h-del" data-del="1" title="Delete">×</button>
        </div>`;
    }).join('');
    // Wire clicks
    document.querySelectorAll('.history-item').forEach(el => {
      el.addEventListener('click', async (e) => {
        if (e.target.dataset.del) return;
        const item = { path: el.dataset.path, sha: el.dataset.sha, name: el.querySelector('.h-title').textContent };
        await loadFromRegistry(item);
      });
    });
    document.querySelectorAll('.h-del').forEach(b => {
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const el = b.closest('.history-item');
        const item = { path: el.dataset.path, sha: el.dataset.sha, name: el.querySelector('.h-title').textContent };
        if (!confirm(`Delete ${item.name}?`)) return;
        try {
          await window.Registry.remove(item);
          el.remove();
        } catch (err) {
          alert('Delete failed: ' + err.message);
        }
      });
    });
  } catch (err) {
    $('historyList').innerHTML = `<div class="empty">Error: ${esc(err.message)}</div>`;
  }
}

async function loadFromRegistry(item) {
  try {
    $('historyList').innerHTML = '<div class="empty">Loading…</div>';
    const payload = await window.Registry.load(item);
    if (!payload.analysis) throw new Error('Saved file has no analysis field.');
    state.analysis = payload.analysis;
    state.history = payload.user_message ? [{ role: 'user', content: payload.user_message }] : [];
    // Close modal
    $('historyModal').classList.remove('show');
    // Render dashboard + summary
    $('messages').innerHTML = '';
    const v = VERDICT_LABELS[state.analysis.verdict] || { text: '—', cls: 'warn' };
    const ml = state.analysis.ml || {};
    const diff = (Number.isFinite(ml.model_hit_rate) && Number.isFinite(ml.baseline_hit_rate))
      ? (ml.model_hit_rate - ml.baseline_hit_rate) * 100 : null;
    const diffStr = diff === null ? '' : (diff >= 0 ? ` Our model beats baseline by ${diff.toFixed(1)} pp.` : ` Our model underperforms baseline by ${(-diff).toFixed(1)} pp.`);
    appendMsg(`<p class="muted">Loaded from registry: <code>${esc(item.name)}</code></p>`, 'bot');
    appendMsg(`<p><b>${state.analysis.series.n_points}</b> points from <b>${esc(state.analysis.series.label || '')}</b>. Signal: <b>${esc(v.text)}</b> (fit quality ${pct(state.analysis.fit.r2, 1)}).${diffStr} Dashboard updated.</p>`, 'bot');
    renderDashboard();
    // Reset to series tab
    document.querySelectorAll('.dash-tab').forEach(t => t.classList.toggle('active', t.dataset.dash === 'series'));
    state.activeTab = 'series';
    renderActiveTab();
  } catch (err) {
    $('historyList').innerHTML = `<div class="empty">Error: ${esc(err.message)}</div>`;
  }
}

// ── Registry settings modal ───────────────────────────────────────────────
function openRegistryModal() {
  $('regRepoInput').value = window.Registry.getRepo();
  $('regTokenInput').value = window.Registry.getToken();
  $('regBranchInput').value = window.Registry.getBranch();
  $('registryModal').classList.add('show');
}
function closeRegistryModal() {
  $('registryModal').classList.remove('show');
}

// ── Feed picker (loads feeds.json on startup) ─────────────────────────────
async function loadFeeds() {
  const sel = $('feedSelect');
  try {
    const r = await fetch('./feeds.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    state.feeds = (data.feeds || []).filter(f => f.url);
    if (!state.feeds.length) {
      sel.innerHTML = '<option value="">(no feeds available)</option>';
      return;
    }
    // Group by domain
    const byDomain = {};
    for (const f of state.feeds) {
      const d = f.domain || 'other';
      if (!byDomain[d]) byDomain[d] = [];
      byDomain[d].push(f);
    }
    const optGroups = Object.entries(byDomain).map(([domain, feeds]) => {
      const opts = feeds.map(f => `<option value="${esc(f.url)}">${esc(f.label)}</option>`).join('');
      return `<optgroup label="${esc(domain)}">${opts}</optgroup>`;
    }).join('');
    sel.innerHTML = `<option value="">— Pick a feed to analyze —</option>${optGroups}`;
    sel.onchange = () => {
      const f = state.feeds.find(x => x.url === sel.value);
      $('feedDesc').textContent = f ? f.description || '' : '';
    };
    $('feedLoadBtn').onclick = () => {
      if (!sel.value) {
        $('feedSelect').focus();
        return;
      }
      const feed = state.feeds.find(f => f.url === sel.value);
      // Store the feed label so send() can pass it to runAnalysis
      state.pendingFeedLabel = feed ? feed.label : null;
      $('chatInput').value = sel.value;
      $('chatInput').focus();
      // Trigger autosend so user doesn't have to click Send
      send();
    };
  } catch (err) {
    sel.innerHTML = '<option value="">(feeds failed to load)</option>';
    console.warn('feeds.json load failed:', err);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────
function init() {
  wireDropzone();
  wireTabs();
  loadFeeds();  // async, populates the dropdown
  $('sendBtn').addEventListener('click', send);
  $('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $('chatInput').addEventListener('input', (e) => {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(140, e.target.scrollHeight) + 'px';
  });

  // Reset / Save / History buttons
  $('resetBtn').addEventListener('click', resetChat);
  $('saveBtn').addEventListener('click', saveToRegistry);
  $('historyBtn').addEventListener('click', openHistoryModal);
  $('historyClose').addEventListener('click', () => $('historyModal').classList.remove('show'));
  $('historyModal').addEventListener('click', (e) => { if (e.target.id === 'historyModal') $('historyModal').classList.remove('show'); });

  // Registry settings modal
  $('registrySave').addEventListener('click', () => {
    window.Registry.setRepo($('regRepoInput').value.trim());
    window.Registry.setToken($('regTokenInput').value.trim());
    window.Registry.setBranch($('regBranchInput').value.trim() || 'main');
    window.Registry.refreshStatus();
    closeRegistryModal();
  });
  $('registryClear').addEventListener('click', () => {
    $('regRepoInput').value = '';
    $('regTokenInput').value = '';
    $('regBranchInput').value = '';
    window.Registry.setRepo('');
    window.Registry.setToken('');
    window.Registry.setBranch('main');
    window.Registry.refreshStatus();
  });
  $('registryClose').addEventListener('click', closeRegistryModal);
  $('registryModal').addEventListener('click', (e) => { if (e.target.id === 'registryModal') closeRegistryModal(); });

  window.addEventListener('resize', () => {
    Object.values(state.charts).forEach(c => c && c.resize());
    if (state.fsChart) state.fsChart.resize();
  });
  // Esc exits fullscreen chart OR closes modals
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (_isFullscreen) { e.preventDefault(); toggleFullscreen(); }
    else if ($('historyModal').classList.contains('show')) { $('historyModal').classList.remove('show'); }
    else if ($('registryModal').classList.contains('show')) { closeRegistryModal(); }
  });
  refreshStatus();
  window.Registry.refreshStatus();
}

init();
