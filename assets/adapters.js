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

  // ── DREAM-site data source adapters ─────────────────────────────────────
  // Each of these matches a source listed on https://dream-physics.onrender.com/retention

  // Open-Meteo (weather archive + forecast) — {hourly: {time: [...], temperature_2m: [...]}}
  if (body?.hourly && Array.isArray(body.hourly.time)) {
    const time = body.hourly.time;
    // Find the first numeric data field (not 'time')
    const dataKey = Object.keys(body.hourly).find(k => k !== 'time' && Array.isArray(body.hourly[k]) && Number.isFinite(Number(body.hourly[k][0])));
    if (dataKey) {
      const vals = body.hourly[dataKey];
      const points = [];
      for (let i = 0; i < time.length; i++) {
        if (vals[i] != null && Number.isFinite(Number(vals[i]))) {
          points.push({ t: time[i], v: Number(vals[i]) });
        }
      }
      if (points.length) return { points, label: label + ' (' + dataKey + ')', unit: body.hourly_units?.[dataKey] || dataKey, source: 'Open-Meteo' };
    }
  }

  // NOAA Tides & Currents — {data: [{t: "2026-07-10 00:00", v: "1.724"}, ...]}
  if (body?.data?.length && body.data[0]?.t && 'v' in body.data[0]) {
    const points = body.data
      .map(d => ({ t: d.t, v: Number(d.v) }))
      .filter(p => Number.isFinite(p.v));
    if (points.length) return { points, label: label + ' (water level)', unit: 'm', source: 'NOAA Tides & Currents' };
  }

  // Binance klines — [[open_time_ms, open, high, low, close, volume, ...], ...]
  if (Array.isArray(body) && body.length && Array.isArray(body[0]) && body[0].length >= 5) {
    const points = body.map(row => ({
      t: new Date(Number(row[0])).toISOString().slice(0, 10),
      v: Number(row[4]),  // close price
    })).filter(p => Number.isFinite(p.v));
    if (points.length) return { points, label: label + ' (close)', unit: 'usd', source: 'Binance' };
  }

  // NOAA SWPC GOES — array of {time_tag, flux/He/Hp/...} (X-rays, magnetometer, electrons, protons)
  // Pick the most plausible numeric field automatically.
  if (Array.isArray(body) && body.length && body[0].time_tag) {
    const candidateFields = ['flux', 'Hp', 'total', 'proton_speed', 'proton_density', 'Kp', 'k_index'];
    let field = candidateFields.find(f => Number.isFinite(Number(body[0][f])));
    if (!field) {
      // Pick first numeric field that's not time_tag/satellite/etc.
      for (const k of Object.keys(body[0])) {
        if (k === 'time_tag' || k === 'satellite' || k === 'energy' || k === 'electron_contaminaton' || k === 'arcjet_flag') continue;
        if (Number.isFinite(Number(body[0][k]))) { field = k; break; }
      }
    }
    if (field) {
      const points = body
        .map(r => ({ t: r.time_tag, v: Number(r[field]) }))
        .filter(p => Number.isFinite(p.v));
      if (points.length) return { points, label: label + ' (' + field + ')', unit: field, source: 'NOAA SWPC GOES' };
    }
  }

  // NOAA SWPC planetary K-index — [[time_tag, k_index, ...], ...] (legacy) OR [{time_tag, Kp}, ...] (new)
  if (Array.isArray(body) && body.length && Array.isArray(body[0])) {
    const points = body.slice(1).map(row => ({ t: row[0], v: Number(row[1]) })).filter(p => Number.isFinite(p.v));
    if (points.length) return { points, label: label + ' (Kp)', unit: 'Kp', source: 'NOAA SWPC' };
  }

  // USGS NWIS Instantaneous Values (Potomac flow etc.)
  // Shape: {value: {timeSeries: [{values: [{value: [{value, dateTime}]}]}]}}
  if (body?.value?.timeSeries?.length) {
    const ts = body.value.timeSeries[0];
    const varName = ts?.variable?.variableName || label;
    const unitCode = ts?.variable?.unit?.unitCode || '';
    const rawVals = ts.values[0]?.value || [];
    const points = rawVals.map(v => ({ t: v.dateTime, v: Number(v.value) })).filter(p => Number.isFinite(p.v));
    if (points.length) return { points, label: varName, unit: unitCode, source: 'USGS NWIS' };
  }

  // USGS GeoJSON (earthquakes) — bucket by hour
  if (body?.features?.length && body.features[0]?.properties?.time != null) {
    const buckets = new Map();
    for (const f of body.features) {
      const t = f.properties?.time;
      if (t == null) continue;
      const key = new Date(t).toISOString().slice(0, 13);
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
    const points = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => ({ t: k + ':00:00Z', v }));
    if (points.length) return { points, label: 'Earthquakes (hourly counts)', unit: 'events/hour', source: 'USGS GeoJSON' };
  }

  // Wikimedia pageviews — {items: [{timestamp: "2024010100", views: 14175}, ...]}
  if (body?.items?.length && body.items[0].views !== undefined) {
    const points = body.items.map(it => ({
      t: it.timestamp.slice(0, 4) + '-' + it.timestamp.slice(4, 6) + '-' + it.timestamp.slice(6, 8),
      v: Number(it.views),
    })).filter(p => Number.isFinite(p.v));
    if (points.length) return { points, label: label + ' (daily views)', unit: 'views', source: 'Wikimedia Pageviews' };
  }

  // World Bank — [[meta], [{date, value, ...}, ...]]
  if (Array.isArray(body) && body.length >= 2 && Array.isArray(body[1]) && body[1][0]?.date && 'value' in body[1][0]) {
    const points = body[1]
      .filter(r => r.value != null)
      .map(r => ({ t: r.date, v: Number(r.value) }))
      .filter(p => Number.isFinite(p.v))
      .sort((a, b) => a.t.localeCompare(b.t));
    if (points.length) return { points, label: label, unit: '', source: 'World Bank' };
  }

  // CoinGecko market_chart — {prices: [[ts_ms, price], ...]}
  if (Array.isArray(body.prices) && body.prices.length && Array.isArray(body.prices[0])) {
    const points = body.prices.map(row => ({
      t: new Date(row[0]).toISOString().slice(0, 10),
      v: Number(row[1]),
    })).filter(p => Number.isFinite(p.v));
    if (points.length) return { points, label, unit: 'usd', source: 'CoinGecko market_chart' };
  }

  // Yahoo chart
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
    if (points.length) return { points, label: r.meta?.symbol || label, unit: 'index', source: 'Yahoo Finance chart' };
  }

  // iNaturalist — {results: [{created_at_details: {date, time}, ...}]}
  // Bucket by day
  if (body?.results?.length && body.results[0]?.created_at_details) {
    const buckets = new Map();
    for (const r of body.results) {
      const d = r.created_at_details?.date;
      if (!d) continue;
      buckets.set(d, (buckets.get(d) || 0) + 1);
    }
    const points = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => ({ t: k, v }));
    if (points.length) return { points, label: 'iNaturalist (daily counts)', unit: 'obs/day', source: 'iNaturalist' };
  }

  // Fallback: try generic shapes
  let arr = Array.isArray(body) ? body : (body.data || body.points || body.values || body.features || []);
  if (!Array.isArray(arr)) throw new Error('Could not extract a time series from JSON payload. Supported: NOAA SWPC GOES/Kp, USGS NWIS/GeoJSON, Wikimedia pageviews, World Bank, CoinGecko, Yahoo chart, iNaturalist, Alpha Vantage, or generic arrays.');

  // Array of numbers
  if (arr.length && typeof arr[0] === 'number') {
    return { points: arr.map((v, i) => ({ t: '', v: Number(v) })).filter(p => Number.isFinite(p.v)), label, unit: '', source: 'JSON numeric array' };
  }
  // Array of [t, v] pairs
  if (arr.length && Array.isArray(arr[0]) && arr[0].length >= 2) {
    return {
      points: arr.map(row => ({ t: String(row[0]), v: Number(row[1] ?? row[0]) })).filter(p => Number.isFinite(p.v)),
      label, unit: '', source: 'JSON [t,v] array',
    };
  }
  // Array of objects
  if (arr.length && typeof arr[0] === 'object') {
    const points = arr.map(item => {
      if (!item || typeof item !== 'object') return null;
      const v = Number(item.v ?? item.value ?? item.y ?? item.close ?? item.metric ?? item.Kp ?? item.k_index ?? item.proton_speed ?? item.flux ?? item.views);
      const t = String(item.t ?? item.time ?? item.date ?? item.timestamp ?? item.x ?? item.time_tag ?? item.dateTime ?? '');
      if (Number.isFinite(v)) return { t, v };
      return null;
    }).filter(Boolean);
    if (points.length) return { points, label, unit: '', source: 'JSON object array' };
  }

  throw new Error('Could not extract a time series from JSON payload. Supported: NOAA SWPC GOES/Kp, USGS NWIS/GeoJSON, Wikimedia pageviews, World Bank, CoinGecko, Yahoo chart, iNaturalist, Alpha Vantage, or generic arrays.');
}

async function fetchAndAdapt(url, label) {
  // Try direct first (works for CORS-open sources: USGS, NOAA, CoinGecko, etc.)
  let directFetchError = null;
  let parseError = null;
  try {
    const r = await fetch(url, { cache: 'no-store', redirect: 'follow' });
    if (r.ok) {
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      const text = await r.text();
      try {
        return parseByText(text, url, ct, label);
      } catch (e) {
        parseError = e;  // fetch worked but parsing failed — save the real error
      }
    } else {
      directFetchError = new Error(`HTTP ${r.status} from ${url}`);
    }
  } catch (e) {
    directFetchError = e;  // CORS or network error
  }

  // If direct fetch worked but parsing failed, throw the parse error directly
  // (don't try the proxy — the proxy will return the same data and parsing will
  // fail the same way).
  if (parseError) throw parseError;

  // If direct fetch failed with a non-OK status (not CORS), throw that error
  if (directFetchError && !directFetchError.message.includes('Failed to fetch') && !directFetchError.message.includes('CORS')) {
    throw directFetchError;
  }

  // Direct fetch failed with a CORS/network error — try the backend proxy
  let backendUrl = null;
  try {
    if (window.Groq && typeof window.Groq._backendUrl === 'function') {
      backendUrl = window.Groq._backendUrl();
    } else if (window.Groq && window.Groq._backendUrlRaw) {
      backendUrl = window.Groq._backendUrlRaw;
    }
  } catch (e) { /* ignore */ }

  if (!backendUrl) {
    throw new Error(`Cannot fetch ${url} — direct fetch failed (${directFetchError?.message || 'unknown error'}) and backend proxy URL is not configured.`);
  }

  const proxyUrl = backendUrl + '/fetch-proxy?url=' + encodeURIComponent(url);
  const r = await fetch(proxyUrl, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url} (via proxy)`);
  const text = await r.text();
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  return parseByText(text, url, ct, label);
}

function parseByText(text, url, ct, label) {
  const useLabel = label || url;
  if (ct.includes('json') || url.endsWith('.json') || text.trim().startsWith('{') || text.trim().startsWith('[')) {
    return seriesFromJSON(text, useLabel);
  }
  if (ct.includes('csv') || ct.includes('text') || url.endsWith('.csv') || url.endsWith('.tsv') || url.endsWith('.txt')) {
    return seriesFromCSV(text, useLabel);
  }
  try { return seriesFromJSON(text, useLabel); }
  catch { return seriesFromCSV(text, useLabel); }
}

return { fetchAndAdapt, seriesFromCSV, seriesFromJSON };
})();
