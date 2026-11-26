// Mark-to-market view of a wallet: what its open positions were worth hour by hour, not just what it realized.
//
// Realized-PnL stats are blind to "bag holding": a trader who sits through a -40% open loss until it comes back
// and then closes at +1% shows a winning trade, a smooth realized curve and a tiny drawdown. To see that pain we
// replay the wallet's fills against hourly price candles and track, for every position:
//   * its maximum adverse excursion (MAE): the worst point of the trade (realized-in-trade + open PnL), vs equity;
//   * how long it sat underwater;
// and for the account as a whole an hourly equity curve that includes open PnL (realized + unrealized).
// Everything here is pure; candles are passed in (see Scanner.pricesFor).
import * as S from './stats.js';

const HOUR = 3600e3;
const num = (x) => (x === null || x === undefined ? 0 : Number(x));
const isPerp = (f) => typeof f.dir === 'string' && /Long|Short/.test(f.dir) && !f.coin.startsWith('@');

// Time ranges per coin where a position was held for at least `minHoldMs` between two fills (or until now).
// Only those ranges need price candles; shorter gaps are fully described by the fill prices.
export function neededPriceRanges(fills, now = Date.now(), minHoldMs = HOUR) {
  const byCoin = groupByCoin(fills);
  const out = new Map();
  for (const [coin, list] of byCoin) {
    let start = Infinity, end = -Infinity;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      const after = num(f.startPosition) + (f.side === 'B' ? 1 : -1) * num(f.sz);
      if (Math.abs(after) < 1e-12) continue;
      const next = i + 1 < list.length ? list[i + 1].time : now;
      if (next - f.time >= minHoldMs) { start = Math.min(start, f.time); end = Math.max(end, next); }
    }
    if (start < end) out.set(coin, [start, end]);
  }
  return out;
}

// Merge candles of different resolutions (e.g. 4h for old history, 1h for recent) into one sorted, non-overlapping
// series of {t, T, h, l, c} numbers, preferring the finer one where both exist.
export function mergeCandles(...sets) {
  const parsed = sets.map((s) => (s || []).map((c) => ({ t: num(c.t), T: num(c.T), h: num(c.h), l: num(c.l), c: num(c.c) })).filter((c) => c.T > c.t && c.c > 0).sort((a, b) => a.t - b.t));
  // sets are given finest first; walk from coarsest to finest, cutting coarse candles where finer data starts.
  let out = [];
  for (let i = parsed.length - 1; i >= 0; i--) {
    const fine = parsed[i];
    if (!fine.length) continue;
    const cut = fine[0].t;
    out = out.filter((c) => c.T < cut).concat(fine);
  }
  return out;
}

function groupByCoin(fills) {
  const byCoin = new Map();
  for (const f of fills) {
    if (!isPerp(f)) continue;
    if (!byCoin.has(f.coin)) byCoin.set(f.coin, []);
    byCoin.get(f.coin).push(f);
  }
  for (const list of byCoin.values()) list.sort((a, b) => a.time - b.time || (a.tid || 0) - (b.tid || 0));
  return byCoin;
}

function firstIdx(series, t) {
  let lo = 0, hi = series.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (series[m].t < t) lo = m + 1; else hi = m; }
  return lo;
}

// prices: Map coin -> merged candles. equityAt: t -> account value. Returns trades with MAE plus account-level stats.
export function markToMarket({ fills, prices, equityAt, now = Date.now(), cfg = {} }) {
  const deepPct = cfg.deepLossPct ?? 0.1; // a position this far underwater (vs equity) counts as a "bag"
  const byCoin = groupByCoin(fills);
  const startTime = fills.length ? Math.min(...fills.map((f) => f.time)) : now;
  const h0 = Math.floor(startTime / HOUR) * HOUR;
  const nH = Math.max(1, Math.ceil((now - h0) / HOUR) + 1);
  const U = new Float64Array(nH); // open PnL at each hour close
  const R = new Float64Array(nH); // realized PnL net of fees booked in each hour
  const trades = [];
  let heldMs = 0, pricedMs = 0;

  for (const [coin, list] of byCoin) {
    const series = prices?.get(coin) || [];
    let szi = 0, entry = 0, trade = null, lastT = list[0].time;

    const mark = (from, to) => {
      // Position (szi @ entry) held unchanged from `from` to `to`.
      if (!szi || to - from < 2 * HOUR) return; // shorter holds are judged on fill prices (no full candle inside)
      heldMs += Math.floor(to / HOUR) * HOUR - Math.ceil(from / HOUR) * HOUR; // the part whole 1h candles can cover
      for (let i = firstIdx(series, from); i < series.length && series[i].T <= to; i++) {
        const c = series[i];
        const adverse = szi > 0 ? c.l : c.h;
        const worst = trade.realized + szi * (adverse - entry);
        if (worst < trade.worst) { trade.worst = worst; trade.worstAt = c.t; }
        const close = szi * (c.c - entry);
        if (close < 0) trade.underwaterMs += c.T - c.t;
        pricedMs += c.T - c.t;
        for (let k = Math.max(0, Math.floor((c.t - h0) / HOUR)); k <= Math.min(nH - 1, Math.floor((c.T - h0) / HOUR)); k++) U[k] += close;
      }
    };
    const open = (f, size, px, truncated) => {
      szi = size; entry = px;
      trade = { coin, side: Math.sign(size), openTime: f.time, closeTime: null, realized: 0, worst: 0, worstAt: f.time, underwaterMs: 0, maxNotional: Math.abs(size) * px, truncated };
    };
    const close = (t) => {
      trades.push({ ...trade, closeTime: t, holdMs: t - trade.openTime, isOpen: false });
      trade = null; szi = 0; entry = 0;
    };

    for (const f of list) {
      const px = num(f.px), sz = num(f.sz);
      const before = num(f.startPosition);
      const signed = f.side === 'B' ? sz : -sz;
      const after = before + signed;
      const flat = (x) => Math.abs(x) <= Math.max(1e-9, sz * 1e-7);
      if (trade && !flat(before - szi)) szi = before; // resync to the exchange's own position size
      mark(lastT, f.time);
      if (trade) { // the fill price itself is a mark too
        const at = trade.realized + szi * (px - entry);
        if (at < trade.worst) { trade.worst = at; trade.worstAt = f.time; }
      }
      lastT = f.time;
      if (!trade && !flat(before)) open(f, before, px, true); // history began mid-trade: entry unknown, use first fill
      const pnl = num(f.closedPnl) - num(f.fee);
      const k = Math.min(nH - 1, Math.max(0, Math.floor((f.time - h0) / HOUR)));
      R[k] += pnl;
      if (!trade) { if (flat(after)) continue; open(f, after, px, false); trade.realized += pnl; continue; }
      trade.realized += pnl;
      if (Math.sign(after) === Math.sign(szi) && Math.abs(after) > Math.abs(szi)) {
        entry = (Math.abs(szi) * entry + (Math.abs(after) - Math.abs(szi)) * px) / Math.abs(after); // averaging in
        szi = after;
        trade.maxNotional = Math.max(trade.maxNotional, Math.abs(after) * px);
        trade.worst = Math.min(trade.worst, trade.realized + szi * (px - entry));
      } else if (flat(after)) close(f.time);
      else if (Math.sign(after) !== Math.sign(szi)) { close(f.time); open(f, after, px, false); }
      else szi = after; // partial close
    }
    if (trade) {
      mark(lastT, now);
      trades.push({ ...trade, closeTime: null, holdMs: now - trade.openTime, isOpen: true });
    }
  }

  // Account-level hourly mark-to-market curve (additive, like the realized one in analyze.js).
  let cumR = 0, prevP = 0, idx = 1, peak = 1, mtmDD = 0, worstOpen = 0, worstOpenAt = null, deepHours = 0, uwHours = 0;
  for (let k = 0; k < nH; k++) {
    const t = h0 + k * HOUR;
    const eq = equityAt(t);
    cumR += R[k];
    const P = cumR + U[k];
    idx += (P - prevP) / eq;
    prevP = P;
    peak = Math.max(peak, idx);
    mtmDD = Math.max(mtmDD, (peak - idx) / peak);
    const open = U[k] / eq;
    if (open < worstOpen) { worstOpen = open; worstOpenAt = t; }
    if (open <= -deepPct) deepHours++;
    if (idx < peak) uwHours++;
  }

  // Per-trade stats.
  const withPct = trades.map((t) => ({ ...t, maePct: t.worst / equityAt(t.worstAt), netPnlPct: t.realized / equityAt(t.openTime) }));
  const judged = withPct.filter((t) => !t.truncated);
  const closed = judged.filter((t) => !t.isOpen);
  const winners = closed.filter((t) => t.realized > 0), losers = closed.filter((t) => t.realized < 0);
  const holdH = (a) => S.median(a.map((t) => t.holdMs / HOUR));
  // A "rescued bag": the position went at least deepPct of equity underwater, then was closed at (or near) breakeven
  // or better. That is exactly the pattern realized stats hide.
  const bags = judged.filter((t) => t.maePct <= -deepPct);
  const rescued = bags.filter((t) => !t.isOpen && t.netPnlPct >= -deepPct / 4);
  const realizedWorst = closed.length ? Math.min(...closed.map((t) => t.netPnlPct)) : 0;
  const mae = judged.map((t) => t.maePct);
  const top = [...withPct].sort((a, b) => a.maePct - b.maePct).slice(0, 5).map((t) => ({
    coin: t.coin, side: t.side, openTime: t.openTime, closeTime: t.closeTime, isOpen: t.isOpen, maePct: t.maePct, netPnlPct: t.netPnlPct, holdHours: t.holdMs / HOUR,
  }));
  return {
    priceCoverage: heldMs > 0 ? Math.min(1, pricedMs / heldMs) : 1,
    mtmMaxDrawdown: mtmDD,
    worstOpenLossPct: worstOpen,
    worstOpenLossAt: worstOpenAt,
    deepOpenLossShare: deepHours / nH, // share of time the book carried an open loss beyond deepPct of equity
    mtmUnderwaterShare: uwHours / nH,
    nTradesJudged: judged.length,
    worstMaePct: mae.length ? Math.min(...mae) : 0,
    p5MaePct: mae.length ? S.quantile(mae, 0.05) : 0,
    worstRealizedPct: realizedWorst,
    bagTrades: bags.length,
    rescuedBags: rescued.length,
    rescuedBagShare: closed.length ? rescued.length / closed.length : 0,
    winnerHoldHours: winners.length >= 8 ? holdH(winners) : null,
    loserHoldHours: losers.length >= 8 ? holdH(losers) : null,
    loserHoldRatio: winners.length >= 8 && losers.length >= 8 ? holdH(losers) / Math.max(holdH(winners), 0.05) : null,
    worstTrades: top,
  };
}
