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

// ── Classification models ─────────────────────────────────────────────────
// Label: 0=DOWN, 1=FLAT, 2=UP (3-class) or 0=DOWN, 1=UP (2-class)
function makeLabels(y, threshold = 0.001) {
  return y.map(v => {
    if (v > threshold) return 2;       // UP
    if (v < -threshold) return 0;      // DOWN
    return 1;                          // FLAT
  });
}

// Logistic regression (binary: UP=1 vs DOWN=0, FLAT dropped for simplicity)
function logisticFit(X, yBinary, lr = 0.01, epochs = 200) {
  const n = X.length;
  if (n === 0) return null;
  const d = X[0].length;
  // Standardize features
  const xmean = new Array(d).fill(0);
  const xstd = new Array(d).fill(0);
  for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) xmean[j] += X[i][j];
  for (let j = 0; j < d; j++) xmean[j] /= n;
  for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) xstd[j] += (X[i][j] - xmean[j]) ** 2;
  for (let j = 0; j < d; j++) xstd[j] = Math.sqrt(xstd[j] / n) || 1;
  const Xs = X.map(row => row.map((v, j) => (v - xmean[j]) / xstd[j]));
  let w = new Array(d).fill(0);
  let b = 0;
  for (let ep = 0; ep < epochs; ep++) {
    const grad_w = new Array(d).fill(0);
    let grad_b = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * Xs[i][j];
      const p = 1 / (1 + Math.exp(-z));
      const err = p - yBinary[i];
      for (let j = 0; j < d; j++) grad_w[j] += err * Xs[i][j];
      grad_b += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * grad_w[j] / n;
    b -= lr * grad_b / n;
  }
  return { w, b, xmean, xstd };
}
function logisticPredict(model, x) {
  if (!model) return 0.5;
  let z = model.b;
  for (let j = 0; j < model.w.length; j++) z += model.w[j] * ((x[j] - model.xmean[j]) / model.xstd[j]);
  return 1 / (1 + Math.exp(-z));
}

// k-Nearest Neighbors (works for both classification and regression)
function knnPredict(Xtrain, ytrain, x, k = 5, isClassification = true) {
  const dists = Xtrain.map((xt, i) => {
    let s = 0;
    for (let j = 0; j < xt.length; j++) s += (xt[j] - x[j]) ** 2;
    return { dist: Math.sqrt(s), idx: i };
  }).sort((a, b) => a.dist - b.dist).slice(0, Math.min(k, Xtrain.length));
  if (isClassification) {
    const counts = {};
    for (const d of dists) counts[ytrain[d.idx]] = (counts[ytrain[d.idx]] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  } else {
    return dists.reduce((s, d) => s + ytrain[d.idx], 0) / dists.length;
  }
}

// Gaussian Naive Bayes (classification)
function naiveBayesFit(X, y, nClasses = 3) {
  const n = X.length;
  const d = X[0].length;
  const models = [];
  for (let c = 0; c < nClasses; c++) {
    const Xc = X.filter((_, i) => y[i] === c);
    if (!Xc.length) { models.push(null); continue; }
    const mean = new Array(d).fill(0);
    const varr = new Array(d).fill(0);
    for (let i = 0; i < Xc.length; i++) for (let j = 0; j < d; j++) mean[j] += Xc[i][j];
    for (let j = 0; j < d; j++) mean[j] /= Xc.length;
    for (let i = 0; i < Xc.length; i++) for (let j = 0; j < d; j++) varr[j] += (Xc[i][j] - mean[j]) ** 2;
    for (let j = 0; j < d; j++) varr[j] = varr[j] / Xc.length + 1e-9;
    models.push({ mean, varr, prior: Xc.length / n });
  }
  return models;
}
function naiveBayesPredict(models, x) {
  let bestClass = 0, bestLogProb = -Infinity;
  for (let c = 0; c < models.length; c++) {
    if (!models[c]) continue;
    let logProb = Math.log(models[c].prior);
    for (let j = 0; j < x.length; j++) {
      const m = models[c].mean[j], v = models[c].varr[j];
      logProb += -0.5 * Math.log(2 * Math.PI * v) - (x[j] - m) ** 2 / (2 * v);
    }
    if (logProb > bestLogProb) { bestLogProb = logProb; bestClass = c; }
  }
  return bestClass;
}

// Classification metrics
function classMetrics(yTrue, yPred, nClasses = 3) {
  let correct = 0;
  const cm = Array.from({ length: nClasses }, () => new Array(nClasses).fill(0));
  for (let i = 0; i < yTrue.length; i++) {
    cm[yTrue[i]][yPred[i]] = (cm[yTrue[i]][yPred[i]] || 0) + 1;
    if (yTrue[i] === yPred[i]) correct++;
  }
  const accuracy = correct / yTrue.length;
  // Per-class precision/recall/F1
  const perClass = [];
  for (let c = 0; c < nClasses; c++) {
    let tp = cm[c][c], fp = 0, fn = 0;
    for (let i = 0; i < nClasses; i++) {
      if (i !== c) { fp += cm[i][c]; fn += cm[c][i]; }
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
    perClass.push({ precision, recall, f1 });
  }
  return { accuracy, confusion: cm, perClass };
}

// Run all classification models
function runClassification(values, horizon, useS2features = true) {
  const n = values.length;
  if (n < 60) throw new Error(`Need at least 60 points, got ${n}`);
  const features = useS2features ? s2Features(values) : baselineFeatures(values);
  const X = [], y = [];
  for (let i = 0; i < n - horizon; i++) {
    if (!features[i]) continue;
    const v0 = values[i], vh = values[i + horizon];
    if (v0 === 0 || !Number.isFinite(vh)) continue;
    X.push(features[i]);
    y.push((vh - v0) / v0);
  }
  if (X.length < 30) throw new Error('Not enough feature rows');
  const split = Math.floor(X.length * 0.8);
  const Xtrain = X.slice(0, split);
  const ytrainRaw = y.slice(0, split);
  const Xtest = X.slice(split);
  const ytestRaw = y.slice(split);

  const threshold = 0.001; // 0.1% return = FLAT
  const ytrainLabels = makeLabels(ytrainRaw, threshold);
  const ytestLabels = makeLabels(ytestRaw, threshold);
  const nClasses = 3;

  const results = {};

  // 1. Logistic regression (binary: UP=1 vs not-UP=0)
  const yBinary = ytrainLabels.map(l => l === 2 ? 1 : 0);
  const yTestBinary = ytestLabels.map(l => l === 2 ? 1 : 0);
  const lrModel = logisticFit(Xtrain, yBinary);
  const lrPreds = Xtest.map(x => logisticPredict(lrModel, x) > 0.5 ? 2 : 0);
  results.logistic = { ...classMetrics(ytestLabels, lrPreds, nClasses), predictions: lrPreds };

  // 2. kNN classification (k=5)
  const knnPreds = Xtest.map(x => Number(knnPredict(Xtrain, ytrainLabels, x, 5, true)));
  results.knn = { ...classMetrics(ytestLabels, knnPreds, nClasses), predictions: knnPreds };

  // 3. Naive Bayes
  const nbModel = naiveBayesFit(Xtrain, ytrainLabels, nClasses);
  const nbPreds = Xtest.map(x => naiveBayesPredict(nbModel, x));
  results.naive_bayes = { ...classMetrics(ytestLabels, nbPreds, nClasses), predictions: nbPreds };

  // 4. Majority-class baseline
  const classCounts = {};
  for (const l of ytrainLabels) classCounts[l] = (classCounts[l] || 0) + 1;
  const majorityClass = Number(Object.entries(classCounts).sort((a, b) => b[1] - a[1])[0][0]);
  const majPreds = Xtest.map(() => majorityClass);
  results.majority = { ...classMetrics(ytestLabels, majPreds, nClasses), predictions: majPreds, majority_class: majorityClass };

  // Next-step prediction (using the last available feature row)
  const lastFeatRow = features.filter(Boolean).pop();
  if (lastFeatRow) {
    results.next_prediction = {
      logistic: logisticPredict(lrModel, lastFeatRow) > 0.5 ? 'UP' : 'DOWN',
      knn: ['DOWN', 'FLAT', 'UP'][Number(knnPredict(Xtrain, ytrainLabels, lastFeatRow, 5, true))],
      naive_bayes: ['DOWN', 'FLAT', 'UP'][naiveBayesPredict(nbModel, lastFeatRow)],
    };
  }

  return { horizon, threshold, n_test: Xtest.length, n_train: Xtrain.length, models: results };
}

// kNN regression
function runKnnRegression(values, horizon, useS2features = true, k = 5) {
  const n = values.length;
  const features = useS2features ? s2Features(values) : baselineFeatures(values);
  const X = [], y = [];
  for (let i = 0; i < n - horizon; i++) {
    if (!features[i]) continue;
    const v0 = values[i], vh = values[i + horizon];
    if (v0 === 0 || !Number.isFinite(vh)) continue;
    X.push(features[i]);
    y.push((vh - v0) / v0);
  }
  if (X.length < 30) throw new Error('Not enough rows');
  const split = Math.floor(X.length * 0.8);
  const Xtrain = X.slice(0, split);
  const ytrain = y.slice(0, split);
  const Xtest = X.slice(split);
  const ytest = y.slice(split);
  const preds = Xtest.map(x => knnPredict(Xtrain, ytrain, x, k, false));
  let mae = 0, hitCount = 0;
  for (let i = 0; i < preds.length; i++) {
    mae += Math.abs(preds[i] - ytest[i]);
    if (Math.sign(preds[i]) === Math.sign(ytest[i])) hitCount++;
  }
  mae = preds.length > 0 ? mae / preds.length : NaN;
  const hitRate = preds.length > 0 ? hitCount / preds.length : NaN;
  const lastFeatRow = features.filter(Boolean).pop();
  const nextPred = lastFeatRow ? knnPredict(Xtrain, ytrain, lastFeatRow, k, false) : NaN;
  return { horizon, next_return_prediction: nextPred, mae, hit_rate: hitRate, n_test: preds.length, n_train: split };
}

// Mean baseline regression (always predict the mean training return)
function runMeanBaseline(values, horizon) {
  const n = values.length;
  const features = baselineFeatures(values);
  const y = [];
  for (let i = 0; i < n - horizon; i++) {
    if (!features[i]) continue;
    const v0 = values[i], vh = values[i + horizon];
    if (v0 === 0 || !Number.isFinite(vh)) continue;
    y.push((vh - v0) / v0);
  }
  if (y.length < 30) throw new Error('Not enough rows');
  const split = Math.floor(y.length * 0.8);
  const ytrain = y.slice(0, split);
  const ytest = y.slice(split);
  const meanReturn = ytrain.reduce((a, b) => a + b, 0) / ytrain.length;
  let mae = 0, hitCount = 0;
  for (let i = 0; i < ytest.length; i++) {
    mae += Math.abs(meanReturn - ytest[i]);
    if (Math.sign(meanReturn) === Math.sign(ytest[i])) hitCount++;
  }
  return { horizon, next_return_prediction: meanReturn, mae: mae / ytest.length, hit_rate: hitCount / ytest.length, n_test: ytest.length, n_train: split };
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
  let ml = { horizon, regression: {}, classification: {} };
  try {
    // Regression models
    const ridgeS2 = runPrediction(values, horizon, true);
    const ridgeBaseline = runPrediction(values, horizon, false);
    const knnReg = runKnnRegression(values, horizon, true);
    const meanBase = runMeanBaseline(values, horizon);
    ml.regression = {
      ridge_s2: { next_return: ridgeS2.next_return_prediction, hit_rate: ridgeS2.hit_rate, mae: ridgeS2.mae, n_test: ridgeS2.n_test },
      ridge_baseline: { next_return: ridgeBaseline.next_return_prediction, hit_rate: ridgeBaseline.hit_rate, mae: ridgeBaseline.mae, n_test: ridgeBaseline.n_test },
      knn: { next_return: knnReg.next_return_prediction, hit_rate: knnReg.hit_rate, mae: knnReg.mae, n_test: knnReg.n_test },
      mean: { next_return: meanBase.next_return_prediction, hit_rate: meanBase.hit_rate, mae: meanBase.mae, n_test: meanBase.n_test },
      // Keep old field names for backward compat with chart code
      model_next_return: ridgeS2.next_return_prediction,
      model_hit_rate: ridgeS2.hit_rate,
      model_mae: ridgeS2.mae,
      model_testIdx: ridgeS2.testIdx,
      model_testPreds: ridgeS2.testPreds,
      model_testY: ridgeS2.testY,
      baseline_next_return: ridgeBaseline.next_return_prediction,
      baseline_hit_rate: ridgeBaseline.hit_rate,
      baseline_mae: ridgeBaseline.mae,
      baseline_testPreds: ridgeBaseline.testPreds,
      baseline_testY: ridgeBaseline.testY,
      n_test: ridgeS2.n_test,
      n_train: ridgeS2.n_train,
    };
  } catch (e) {
    ml.regression.error = e.message;
  }
  try {
    // Classification models
    ml.classification = runClassification(values, horizon, true);
  } catch (e) {
    ml.classification.error = e.message;
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
