// Small statistics toolkit (no dependencies).

export const sum = (a) => a.reduce((s, x) => s + x, 0);
export const mean = (a) => (a.length ? sum(a) / a.length : 0);

export function std(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(sum(a.map((x) => (x - m) ** 2)) / (a.length - 1));
}

export function skewness(a) {
  const n = a.length;
  if (n < 3) return 0;
  const m = mean(a);
  const s = Math.sqrt(sum(a.map((x) => (x - m) ** 2)) / n);
  if (s === 0) return 0;
  return sum(a.map((x) => ((x - m) / s) ** 3)) / n;
}

// Non-excess kurtosis (normal = 3).
export function kurtosis(a) {
  const n = a.length;
  if (n < 4) return 3;
  const m = mean(a);
  const s2 = sum(a.map((x) => (x - m) ** 2)) / n;
  if (s2 === 0) return 3;
  return sum(a.map((x) => (x - m) ** 4)) / n / (s2 * s2);
}

export function quantile(a, q) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
export const median = (a) => quantile(a, 0.5);

// Standard normal CDF (Abramowitz-Stegun 7.1.26 via erf).
export function normCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

// Inverse standard normal CDF (Acklam's algorithm).
export function normInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q, r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// Per-period Sharpe ratio (no risk-free rate; crypto perps margin earns ~nothing).
export function sharpe(r) {
  const s = std(r);
  return s > 0 ? mean(r) / s : 0;
}

export function sortino(r) {
  if (r.length < 2) return 0;
  const downside = Math.sqrt(sum(r.map((x) => Math.min(0, x) ** 2)) / r.length);
  if (downside === 0) return mean(r) > 0 ? 10 : 0; // no losing periods: cap instead of Infinity
  return mean(r) / downside;
}

// Probabilistic Sharpe Ratio (Bailey & Lopez de Prado 2012):
// probability that the true Sharpe exceeds `benchmark`, given T observations with this skew/kurtosis.
export function probabilisticSharpe(r, benchmark = 0) {
  const T = r.length;
  if (T < 3) return 0;
  const sr = sharpe(r);
  const g3 = skewness(r);
  const g4 = kurtosis(r);
  const denom = Math.sqrt(Math.max(1e-12, 1 - g3 * sr + ((g4 - 1) / 4) * sr * sr));
  return normCdf(((sr - benchmark) * Math.sqrt(T - 1)) / denom);
}

// Same as above from stored moments, so DSR can be recomputed when N or k changes without refetching.
export const moments = (r) => ({ sr: sharpe(r), T: r.length, g3: skewness(r), g4: kurtosis(r) });
export function psrFromMoments({ sr, T, g3, g4 }, benchmark = 0) {
  if (!T || T < 3) return 0;
  const denom = Math.sqrt(Math.max(1e-12, 1 - g3 * sr + ((g4 - 1) / 4) * sr * sr));
  return normCdf(((sr - benchmark) * Math.sqrt(T - 1)) / denom);
}

// Expected maximum Sharpe among `nTrials` independent strategies with zero true skill
// (False Strategy Theorem, Bailey & Lopez de Prado 2014). This is the luck benchmark:
// with tens of thousands of wallets, the best *lucky* one will show roughly this Sharpe.
//
// topK > 1 generalises this to a shortlist: the expected Sharpe of the k-th luckiest wallet out of N
// (normal order statistic, z = Phi^-1(1 - k/(N+1))). Picking a top-25 out of 7,000 needs less than beating
// the single luckiest wallet, but still far more than "Sharpe > 0".
export function expectedMaxSharpe(nTrials, T, topK = 1) {
  if (nTrials <= 1 || T < 2) return 0;
  const sdSR = Math.sqrt(1 / (T - 1));
  if (topK > 1) return sdSR * normInv(1 - Math.min(0.5, topK / (nTrials + 1)));
  const gamma = 0.5772156649;
  return sdSR * ((1 - gamma) * normInv(1 - 1 / nTrials) + gamma * normInv(1 - 1 / (nTrials * Math.E)));
}

// Deflated Sharpe Ratio: PSR measured against the luck benchmark instead of 0.
export function deflatedSharpe(r, nTrials, topK = 1) {
  return probabilisticSharpe(r, expectedMaxSharpe(nTrials, r.length, topK));
}

// Max drawdown of an equity curve, as a fraction of the running peak.
// Max drawdown as a fraction of the running peak (capped at 100%).
export function maxDrawdown(equity) {
  let peak = -Infinity;
  let mdd = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    if (peak > 0) mdd = Math.max(mdd, Math.min(1, (peak - v) / peak));
  }
  return mdd;
}

export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
