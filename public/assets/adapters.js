// ============================================================================
// Data adapters — turn a fetched URL or pasted file content into a uniform
// {points: [{t, v}], label, unit, source} shape that the engine expects.
// Exposed as window.Adapters.
// ============================================================================

window.Adapters = (function () {

function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter(l => l.trim());
  if (!lines.length) return { headers: [], rows: [] };
  const delim = lines[0].includes('\t') ? '\t' : (lines[0].split(',').length >= lines[0].split(';').length ? ',' : ';');
  const parseLine = (line) => {
    const out = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { inQ = !inQ; continue; }
      if (c === delim && !inQ) { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    out.push(cur);
    return out.map(s => s.trim());
  };
  const headers = parseLine(lines[0]);
  const rows = lines.slice(1).map(parseLine);
  return { headers, rows };
}

function seriesFromCSV(text, label = 'CSV upload') {
  const { headers, rows } = parseCSV(text);
  if (!headers.length) throw new Error('CSV has no headers');
  let valueIdx = -1;
  const score = headers.map((h, i) => {
    let n = 0;
    for (const r of rows.slice(0, 50)) if (r[i] != null && Number.isFinite(Number(r[i]))) n++;
    return { i, n };
  }).sort((a, b) => b.n - a.n);
  if (score.length && score[0].n > 0) valueIdx = score[0].i;
  if (valueIdx < 0) throw new Error('No numeric column found in CSV');
  let dateIdx = headers.findIndex(h => /^(t|time|date|datetime|timestamp|x|day|hour)$/i.test(h));
  if (dateIdx < 0) dateIdx = headers.findIndex(h => /date|time|timestamp/i.test(h));
  const points = [];
  for (const r of rows) {
    const v = Number(r[valueIdx]);
    if (!Number.isFinite(v)) continue;
    points.push({ t: dateIdx >= 0 ? (r[dateIdx] || '') : '', v });
  }
  if (!points.length) throw new Error('CSV produced no usable rows');
  return { points, label, unit: '', source: 'uploaded CSV' };
}

function seriesFromJSON(text, label = 'JSON upload') {
  const body = JSON.parse(text);

  // Alpha Vantage: demo key returns {"Information": "..."} or {"Note": "..."}
  // instead of real data. Detect and give a friendly error.
  if (body && (body.Information || body.Note)) {
    throw new Error('Alpha Vantage says: ' + (body.Information || body.Note) + ' — get a free key at https://www.alphavantage.co/support/#api-key and add apikey=YOUR_KEY to the URL. The demo key only works for IBM intraday, not full daily.');
  }
  // Alpha Vantage real response: {"Time Series (Daily)": {"2026-07-10": {"1. open":..., "4. close":...}, ...}}
  if (body && body['Time Series (Daily)']) {
    const ts = body['Time Series (Daily)'];
    const points = Object.entries(ts)
      .map(([date, ohlc]) => ({ t: date, v: Number(ohlc['4. close']) }))
      .filter(p => Number.isFinite(p.v))
      .sort((a, b) => a.t.localeCompare(b.t));
    if (points.length) return { points, label: label + ' (close)', unit: 'usd', source: 'Alpha Vantage' };
  }

  let arr = Array.isArray(body) ? body : (body.data || body.points || body.values || body.prices || body.features || []);
  if (!Array.isArray(arr)) throw new Error('JSON must be array, or object with .data/.points/.values/.prices/.features array, or Alpha Vantage "Time Series (Daily)" shape');

  if (body?.chart?.result?.[0]) {
    const r = body.chart.result[0];
    const ts = r.timestamp || [];
    const closes = (r.indicators?.quote?.[0] || {}).close || [];
    const points = [];
    for (let i = 0; i < ts.length; i++) {
      if (closes[i] != null && Number.isFinite(Number(closes[i]))) {
        points.push({ t: new Date(ts[i] * 1000).toISOString().slice(0, 10), v: Number(closes[i]) });
      }
    }
    return { points, label: r.meta?.symbol || label, unit: 'index', source: 'Yahoo Finance chart' };
  }

  if (Array.isArray(body.prices) && body.prices.length && Array.isArray(body.prices[0])) {
    const points = body.prices.map(row => ({
      t: new Date(row[0]).toISOString().slice(0, 10),
      v: Number(row[1]),
    })).filter(p => Number.isFinite(p.v));
    return { points, label, unit: 'usd', source: 'CoinGecko market_chart' };
  }

  if (body?.features?.length && body.features[0]?.properties?.time != null) {
    const buckets = new Map();
    for (const f of body.features) {
      const t = f.properties?.time;
      if (t == null) continue;
      const key = new Date(t).toISOString().slice(0, 13);
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
    const points = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => ({ t: k + ':00:00Z', v }));
    return { points, label: 'Earthquakes (hourly counts)', unit: 'events/hour', source: 'USGS GeoJSON' };
  }

  if (arr.length && typeof arr[0] === 'number') {
    return { points: arr.map((v, i) => ({ t: '', v: Number(v) })).filter(p => Number.isFinite(p.v)), label, unit: '', source: 'JSON numeric array' };
  }

  if (arr.length && Array.isArray(arr[0]) && arr[0].length >= 2) {
    return {
      points: arr.map(row => ({ t: String(row[0]), v: Number(row[1] ?? row[0]) })).filter(p => Number.isFinite(p.v)),
      label, unit: '', source: 'JSON [t,v] array',
    };
  }

  if (arr.length && typeof arr[0] === 'object') {
    const points = arr.map(item => {
      if (!item || typeof item !== 'object') return null;
      const v = Number(item.v ?? item.value ?? item.y ?? item.close ?? item.metric ?? item.Kp ?? item.k_index ?? item.proton_speed);
      const t = String(item.t ?? item.time ?? item.date ?? item.timestamp ?? item.x ?? item.time_tag ?? '');
      if (Number.isFinite(v)) return { t, v };
      return null;
    }).filter(Boolean);
    if (points.length) return { points, label, unit: '', source: 'JSON object array' };
  }

  throw new Error('Could not extract a time series from JSON payload');
}

async function fetchAndAdapt(url) {
  // Try direct first (works for CORS-open sources: USGS, NOAA, CoinGecko, etc.)
  try {
    const r = await fetch(url, { cache: 'no-store', redirect: 'follow' });
    if (r.ok) {
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      const text = await r.text();
      try {
        return parseByText(text, url, ct);
      } catch (e) {
        // fall through to proxy
      }
    }
  } catch (e) {
    // CORS or network error — fall through to proxy
  }

  // Fallback: route through the backend proxy (handles CORS + User-Agent).
  // The backend has a /fetch-proxy?url=... endpoint that fetches server-side.
  // We try to get the backend URL from window.Groq._backendUrl() if available,
  // but fall back to reading it directly from the source if not (so a version
  // mismatch between adapters.js and groq.js doesn't break everything).
  let backendUrl = null;
  try {
    if (window.Groq && typeof window.Groq._backendUrl === 'function') {
      backendUrl = window.Groq._backendUrl();
    } else if (window.Groq && window.Groq._backendUrlRaw) {
      backendUrl = window.Groq._backendUrlRaw;
    }
  } catch (e) { /* ignore */ }

  if (!backendUrl) {
    throw new Error(`Cannot fetch ${url} — direct fetch failed (CORS or network) and backend proxy URL is not configured. To fix: push the latest public/assets/groq.js to your repo.`);
  }

  const proxyUrl = backendUrl + '/fetch-proxy?url=' + encodeURIComponent(url);
  const r = await fetch(proxyUrl, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url} (via proxy)`);
  const text = await r.text();
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  return parseByText(text, url, ct);
}

function parseByText(text, url, ct) {
  if (ct.includes('json') || url.endsWith('.json') || text.trim().startsWith('{') || text.trim().startsWith('[')) {
    return seriesFromJSON(text, url);
  }
  if (ct.includes('csv') || ct.includes('text') || url.endsWith('.csv') || url.endsWith('.tsv') || url.endsWith('.txt')) {
    return seriesFromCSV(text, url);
  }
  try { return seriesFromJSON(text, url); }
  catch { return seriesFromCSV(text, url); }
}

return { fetchAndAdapt, seriesFromCSV, seriesFromJSON };
})();
