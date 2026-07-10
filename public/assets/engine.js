// ============================================================================
// Analysis engine — pure browser JS, no deps.
// Exposed as window.Engine so app.js can call it.
// ============================================================================

window.Engine = (function () {

function gaussianSmooth(values, lambda) {
  if (lambda <= 0) return values.slice();
  const sigma = lambda;
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = [];
  for (let i = -radius; i <= radius; i++) kernel.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const ksum = kernel.reduce((a, b) => a + b, 0);
  const out = new Array(values.length).fill(NaN);
  for (let i = 0; i < values.length; i++) {
    let acc = 0, wsum = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j < 0 || j >= values.length) continue;
      if (!Number.isFinite(values[j])) continue;
      acc += values[j] * kernel[k + radius];
      wsum += kernel[k + radius];
    }
    out[i] = wsum > 0 ? acc / wsum : NaN;
  }
  return out;
}

function computeRetentionCurve(values, lambdaGrid) {
  let rawEnergy = 0, rawN = 0;
  for (let i = 0; i + 1 < values.length; i++) {
    const d = values[i + 1] - values[i];
    if (Number.isFinite(d)) { rawEnergy += d * d; rawN++; }
  }
  rawEnergy = rawN > 0 ? rawEnergy / rawN : 0;
  if (rawEnergy <= 0) return lambdaGrid.map(lambda => ({ lambda, R: NaN, logR: NaN }));
  const curve = [];
  for (const lambda of lambdaGrid) {
    const sm = gaussianSmooth(values, lambda);
    let smoothEnergy = 0, sN = 0;
    for (let i = 0; i + 1 < sm.length; i++) {
      const d = sm[i + 1] - sm[i];
      if (Number.isFinite(d)) { smoothEnergy += d * d; sN++; }
    }
    smoothEnergy = sN > 0 ? smoothEnergy / sN : 0;
    const R = smoothEnergy / rawEnergy;
    curve.push({ lambda, R, logR: R > 0 ? Math.log(R) : NaN });
  }
  return curve;
}

function fitS2(retentionCurve) {
  const pts = retentionCurve.filter(p => p.R > 0 && p.R < 1);
  if (pts.length < 3) return { lambda_q: NaN, D: NaN, r2: NaN, fit: [] };
  const xs = pts.map(p => Math.log(p.lambda));
  const ys = pts.map(p => Math.log(-Math.log(p.R)));
  const n = xs.length;
  const xmean = xs.reduce((a, b) => a + b, 0) / n;
  const ymean = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xmean) * (ys[i] - ymean);
    den += (xs[i] - xmean) ** 2;
  }
  const D = den > 0 ? num / den : 0;
  const intercept = ymean - D * xmean;
  const lambda_q = D !== 0 ? Math.exp(-intercept / D) : NaN;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    const yhat = D * xs[i] + intercept;
    ssRes += (ys[i] - yhat) ** 2;
    ssTot += (ys[i] - ymean) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : NaN;
  const fit = pts.map(p => ({ lambda: p.lambda, R: Math.exp(-Math.pow(p.lambda / lambda_q, D)) }));
  return { lambda_q, D, r2, fit };
}

function baselineFeatures(values) {
  const n = values.length;
  const feats = [];
  for (let i = 0; i < n; i++) {
    if (i < 20) { feats.push(null); continue; }
    const window = values.slice(i - 20, i + 1);
    const last = values[i];
    const first = window[0];
    const ret = first !== 0 ? (last - first) / first : 0;
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length;
    const vol = Math.sqrt(variance) / (Math.abs(mean) || 1);
    let g = 0, l = 0, gn = 0, ln = 0;
    for (let k = i - 13; k <= i; k++) {
      const d = values[k] - values[k - 1];
      if (d > 0) { g += d; gn++; } else if (d < 0) { l += -d; ln++; }
    }
    const rs = (ln > 0 ? (g / Math.max(1, gn)) / (l / Math.max(1, ln)) : 100);
    const rsi = 100 - 100 / (1 + rs);
    let peak = -Infinity;
    for (let k = i - 20; k <= i; k++) peak = Math.max(peak, values[k]);
    const dd = peak !== 0 ? (last - peak) / peak : 0;
    feats.push([ret, vol, rsi, dd, (last - mean) / (Math.abs(mean) || 1)]);
  }
  return feats;
}

function s2Features(values, lambdaGrid = [1, 2, 4, 8, 16, 32, 64, 128, 256]) {
  const base = baselineFeatures(values);
  return base.map((b, i) => {
    if (!b) return null;
    const window = values.slice(Math.max(0, i - 59), i + 1);
    if (window.length < 30) return [...b, 0, 0, 0, 0];
    const curve = computeRetentionCurve(window, lambdaGrid);
    const R5 = curve.find(c => c.lambda === 5)?.R ?? 0;
    const R20 = curve.find(c => c.lambda === 20)?.R ?? 0;
    const R60 = curve.find(c => c.lambda === 60)?.R ?? 0;
    const fit = fitS2(curve);
    return [...b, R5, R20, R60, fit.D || 0];
  });
}

function ridgeFit(X, y, lambda = 1.0) {
  const n = X.length;
  if (n === 0) return null;
  const d = X[0].length;
  const xmean = new Array(d).fill(0);
  for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) xmean[j] += X[i][j];
  for (let j = 0; j < d; j++) xmean[j] /= n;
  const ymean = y.reduce((a, b) => a + b, 0) / n;
  const Xc = X.map(row => row.map((v, j) => v - xmean[j]));
  const yc = y.map(v => v - ymean);
  const XtX = new Array(d).fill(0).map(() => new Array(d).fill(0));
  const Xty = new Array(d).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < d; j++) {
      Xty[j] += Xc[i][j] * yc[i];
      for (let k = 0; k < d; k++) XtX[j][k] += Xc[i][j] * Xc[i][k];
    }
  }
  for (let j = 0; j < d; j++) XtX[j][j] += lambda;
  const A = XtX.map(row => row.slice());
  const b = Xty.slice();
  for (let p = 0; p < d; p++) {
    let maxRow = p;
    for (let r = p + 1; r < d; r++) if (Math.abs(A[r][p]) > Math.abs(A[maxRow][p])) maxRow = r;
    [A[p], A[maxRow]] = [A[maxRow], A[p]]; [b[p], b[maxRow]] = [b[maxRow], b[p]];
    if (Math.abs(A[p][p]) < 1e-12) return null;
    for (let r = p + 1; r < d; r++) {
      const f = A[r][p] / A[p][p];
      for (let c = p; c < d; c++) A[r][c] -= f * A[p][c];
      b[r] -= f * b[p];
    }
  }
  const w = new Array(d).fill(0);
  for (let p = d - 1; p >= 0; p--) {
    let s = b[p];
    for (let c = p + 1; c < d; c++) s -= A[p][c] * w[c];
    w[p] = s / A[p][p];
  }
  return { w, xmean, ymean };
}
function ridgePredict(model, x) {
  if (!model) return 0;
  let s = model.ymean;
  for (let j = 0; j < model.w.length; j++) s += model.w[j] * (x[j] - model.xmean[j]);
  return s;
}

function runPrediction(values, horizon, useS2) {
  const n = values.length;
  if (n < 60) throw new Error(`Need at least 60 points, got ${n}`);
  const features = useS2 ? s2Features(values) : baselineFeatures(values);
  const X = [], y = [], idxAll = [];
  for (let i = 0; i < n - horizon; i++) {
    if (!features[i]) continue;
    const v0 = values[i], vh = values[i + horizon];
    if (v0 === 0 || !Number.isFinite(vh)) continue;
    X.push(features[i]);
    y.push((vh - v0) / v0);
    idxAll.push(i);
  }
  if (X.length < 30) throw new Error('Not enough feature rows after windowing');
  const split = Math.floor(X.length * 0.8);
  const model = ridgeFit(X.slice(0, split), y.slice(0, split), 1.0);
  const testPreds = X.slice(split).map(x => ridgePredict(model, x));
  const testY = y.slice(split);
  const testIdx = idxAll.slice(split);
  let mae = 0, hitCount = 0;
  for (let i = 0; i < testPreds.length; i++) {
    mae += Math.abs(testPreds[i] - testY[i]);
    if (Math.sign(testPreds[i]) === Math.sign(testY[i])) hitCount++;
  }
  mae = testPreds.length > 0 ? mae / testPreds.length : NaN;
  const hitRate = testPreds.length > 0 ? hitCount / testPreds.length : NaN;
  const lastIdx = features.filter(Boolean).length - 1;
  const lastFeatRow = features.filter(Boolean)[lastIdx];
  const nextPred = ridgePredict(model, lastFeatRow);
  return {
    horizon,
    next_return_prediction: nextPred,
    mae, hit_rate: hitRate,
    n_test: testPreds.length,
    n_train: split,
    testIdx, testPreds, testY,
  };
}

function verdictFromFit(fit) {
  if (!Number.isFinite(fit.r2) || fit.r2 < 0.5) return 'WEAK';
  if (fit.D > 0 && fit.D < 1 && fit.r2 > 0.85) return 'HOLDS';
  if (fit.r2 > 0.7) return 'WEAK';
  return 'FAILS';
}

function rollingStats(values, windowSize = 20) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    if (i < windowSize) { out.push(null); continue; }
    const w = values.slice(i - windowSize + 1, i + 1);
    const mean = w.reduce((a, b) => a + b, 0) / w.length;
    const variance = w.reduce((a, b) => a + (b - mean) ** 2, 0) / w.length;
    const vol = Math.sqrt(variance);
    let g = 0, l = 0, gn = 0, ln = 0;
    for (let k = i - 13; k <= i; k++) {
      const d = values[k] - values[k - 1];
      if (d > 0) { g += d; gn++; } else if (d < 0) { l += -d; ln++; }
    }
    const rs = ln > 0 ? (g / Math.max(1, gn)) / (l / Math.max(1, ln)) : 100;
    const rsi = 100 - 100 / (1 + rs);
    let peak = -Infinity;
    for (let k = i - windowSize + 1; k <= i; k++) peak = Math.max(peak, values[k]);
    const dd = peak !== 0 ? (values[i] - peak) / peak : 0;
    out.push({ i, mean, vol, rsi, dd });
  }
  return out;
}

function analyzeSeries(points, label, unit, source) {
  const values = points.map(p => p.v).filter(v => Number.isFinite(v));
  if (values.length < 30) {
    return { error: `Only ${values.length} usable numeric points — need at least 30 for analysis.` };
  }
  const lambdaGrid = [1, 2, 4, 8, 16, 32, 64, 128, 256];
  const retention = computeRetentionCurve(values, lambdaGrid);
  const fit = fitS2(retention);
  const verdict = verdictFromFit(fit);
  const horizon = 5;
  let ml = { horizon, model_next_return: null, baseline_next_return: null, model_hit_rate: null, baseline_hit_rate: null, n_test: 0 };
  try {
    const modelPred = runPrediction(values, horizon, true);
    const baselinePred = runPrediction(values, horizon, false);
    ml = {
      horizon,
      model_next_return: modelPred.next_return_prediction,
      model_hit_rate: modelPred.hit_rate,
      model_mae: modelPred.mae,
      model_testIdx: modelPred.testIdx,
      model_testPreds: modelPred.testPreds,
      model_testY: modelPred.testY,
      baseline_next_return: baselinePred.next_return_prediction,
      baseline_hit_rate: baselinePred.hit_rate,
      baseline_mae: baselinePred.mae,
      baseline_testPreds: baselinePred.testPreds,
      baseline_testY: baselinePred.testY,
      n_test: modelPred.n_test,
      n_train: modelPred.n_train,
    };
  } catch (e) {
    ml.error = e.message;
  }
  const step = Math.max(1, Math.floor(values.length / 200));
  const raw_preview = [];
  for (let i = 0; i < values.length; i += step) raw_preview.push({ i, v: values[i] });
  const rolling = rollingStats(values, 20);
  return {
    series: {
      label, unit, source,
      n_points: values.length,
      latest_t: points[points.length - 1]?.t || null,
      first_value: values[0],
      last_value: values[values.length - 1],
      values,
      timestamps: points.map(p => p.t),
    },
    fit: { r2: fit.r2 },
    verdict,
    raw_preview,
    rolling,
    ml,
  };
}

return { analyzeSeries };
})();
