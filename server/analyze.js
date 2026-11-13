// Turns raw Hyperliquid data for one wallet into trades and metrics.
// Everything here is pure (no network), so it can be unit-tested and re-run cheaply.
import * as S from './stats.js';
import { classify, CLASSES, isTradFi } from './assets.js';

const DAY = 86400e3;
const num = (x) => (x === null || x === undefined ? 0 : Number(x));
const SYSTEM_ADDRESSES = new Set([
  '0x2222222222222222222222222222222222222222', // HYPE system address
  '0x0000000000000000000000000000000000000000',
]);

// ---------- Equity reference from the portfolio endpoint ----------
// portfolio returns [["day",{accountValueHistory,pnlHistory,vlm}],["week",..],["month",..],["allTime",..],["perpDay",..]...]
export function equityHistory(portfolio) {
  const pts = new Map();
  for (const [win, d] of portfolio || []) {
    if (!['allTime', 'month', 'week', 'day'].includes(win)) continue;
    for (const [t, v] of d.accountValueHistory || []) pts.set(t, num(v));
  }
  return [...pts.entries()].sort((a, b) => a[0] - b[0]);
}

export function makeEquityAt(hist, fallback) {
  const positives = hist.map((p) => p[1]).filter((v) => v > 0);
  const med = positives.length ? S.median(positives) : fallback || 1;
  const floor = Math.max(1, med * 0.1); // avoid exploding returns when the balance was ~0
  return (t) => {
    if (!hist.length) return Math.max(floor, fallback || med);
    if (t <= hist[0][0]) return Math.max(floor, hist[0][1] || med);
    if (t >= hist[hist.length - 1][0]) return Math.max(floor, hist[hist.length - 1][1]);
    let lo = 0, hi = hist.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (hist[m][0] <= t) lo = m; else hi = m; }
    const [t0, v0] = hist[lo], [t1, v1] = hist[hi];
    const v = v0 + ((v1 - v0) * (t - t0)) / Math.max(1, t1 - t0);
    return Math.max(floor, v);
  };
}

// Perp fills have dir like "Open Long" / "Close Short" / "Long > Short"; spot fills are "Buy" / "Sell".
export const isPerpFill = (f) => typeof f.dir === 'string' && /Long|Short/.test(f.dir) && !f.coin.startsWith('@');

// ---------- Closing events ----------
// Many good traders never go fully flat (they scale in and out of a running position), so round trips undercount
// their decisions. A "closing event" is a burst of reducing fills in one coin (gaps < 1h); its realized PnL is one
// sample of the trader's edge. These are the unit for win rate, payoff, concentration and per-trade Sharpe.
export function closingEvents(fills, address = '') {
  const me = address.toLowerCase();
  const byCoin = new Map();
  for (const f of fills) {
    if (!isPerpFill(f)) continue;
    if (!/^Close|>/.test(f.dir) && !Number(f.closedPnl)) continue;
    if (!byCoin.has(f.coin)) byCoin.set(f.coin, []);
    byCoin.get(f.coin).push(f);
  }
  const events = [];
  for (const [coin, list] of byCoin) {
    list.sort((a, b) => a.time - b.time);
    let cur = null;
    for (const f of list) {
      if (!cur || f.time - cur.lastTime > 3600e3) {
        if (cur) events.push(cur);
        cur = { coin, time: f.time, lastTime: f.time, pnl: 0, notional: 0, liquidated: false };
      }
      cur.pnl += num(f.closedPnl) - num(f.fee);
      cur.notional += num(f.px) * num(f.sz);
      cur.lastTime = f.time;
      if (f.liquidation && (!me || (f.liquidation.liquidatedUser || '').toLowerCase() === me)) cur.liquidated = true;
    }
    if (cur) events.push(cur);
  }
  return events.sort((a, b) => a.time - b.time);
}

// Walks fills per coin to get (a) gross exposure samples for leverage and (b) an inventory-turnover holding time:
// hold ~= time-integrated |position notional| / notional closed. Works whether or not the trader ever goes flat.
export function exposureProfile(fills, equityAt, now = Date.now()) {
  const pos = new Map(); // coin -> {size, px, t}
  let integral = 0, closedNtl = 0;
  const levSamples = [];
  const sorted = fills.filter(isPerpFill).sort((a, b) => a.time - b.time);
  for (const f of sorted) {
    const p = pos.get(f.coin) || { size: num(f.startPosition), px: num(f.px), t: f.time };
    integral += Math.abs(p.size) * p.px * Math.max(0, f.time - p.t);
    const signed = f.side === 'B' ? num(f.sz) : -num(f.sz);
    const before = num(f.startPosition);
    const after = before + signed;
    if (Math.abs(after) < Math.abs(before) || Math.sign(after) !== Math.sign(before)) closedNtl += Math.min(Math.abs(before), num(f.sz)) * num(f.px);
    pos.set(f.coin, { size: after, px: num(f.px), t: f.time });
    let gross = 0;
    for (const q of pos.values()) gross += Math.abs(q.size) * q.px;
    levSamples.push(gross / equityAt(f.time));
  }
  for (const q of pos.values()) integral += Math.abs(q.size) * q.px * Math.max(0, now - q.t);
  return { inventoryHoldHours: closedNtl > 0 ? integral / closedNtl / 3600e3 : null, levSamples };
}

// ---------- Round-trip trades from fills ----------
// A trade opens when a coin's position leaves 0 and closes when it returns to 0 (a flip closes one trade and opens another).
export function buildTrades(fills, address) {
  const sorted = [...fills].sort((a, b) => a.time - b.time || a.tid - b.tid);
  const open = new Map();
  const trades = [];
  const addr = (address || '').toLowerCase();
  const flat = (x, ref) => Math.abs(x) <= Math.max(1e-9, Math.abs(ref) * 1e-7);

  const start = (f, side, size, px, truncated) => ({
    coin: f.coin, side, openTime: f.time, closeTime: null, entryCost: size * px, entrySize: size,
    maxSize: size, maxNotional: size * px, pnl: 0, fees: 0, fills: 0, makerFills: 0, liquidated: false, truncated,
    exitPx: null,
  });

  for (const f of sorted) {
    if (!isPerpFill(f)) continue;
    const sz = num(f.sz);
    const px = num(f.px);
    const signed = f.side === 'B' ? sz : -sz;
    const before = num(f.startPosition);
    const after = before + signed;
    let t = open.get(f.coin);
    if (!t) {
      if (!flat(before, sz)) t = start(f, Math.sign(before), Math.abs(before), px, true); // history began mid-trade
      else t = start(f, Math.sign(signed), 0, px, false), (t.entryCost = 0);
      open.set(f.coin, t);
    }
    t.fills++;
    if (!f.crossed) t.makerFills++;
    t.pnl += num(f.closedPnl);
    t.fees += num(f.fee);
    if (f.liquidation && (!addr || (f.liquidation.liquidatedUser || '').toLowerCase() === addr)) t.liquidated = true;

    const increasing = Math.sign(signed) === t.side && Math.abs(after) > Math.abs(before);
    if (increasing) {
      const added = Math.abs(after) - Math.abs(before);
      t.entryCost += added * px;
      t.entrySize += added;
    }
    t.maxSize = Math.max(t.maxSize, Math.abs(after));
    t.maxNotional = Math.max(t.maxNotional, Math.abs(after) * px, Math.abs(before) * px);

    const flipped = !flat(after, sz) && Math.sign(after) !== t.side;
    if (flat(after, sz) || flipped) {
      t.closeTime = f.time;
      t.exitPx = px;
      trades.push(finish(t));
      open.delete(f.coin);
      if (flipped) {
        const nt = start(f, Math.sign(after), Math.abs(after), px, false);
        open.set(f.coin, nt);
      }
    }
  }
  for (const t of open.values()) trades.push(finish(t));
  return trades.sort((a, b) => a.openTime - b.openTime);
}

function finish(t) {
  return {
    ...t,
    entryPx: t.entrySize > 0 ? t.entryCost / t.entrySize : null,
    netPnl: t.pnl - t.fees,
    isOpen: t.closeTime === null,
    holdMs: t.closeTime === null ? null : t.closeTime - t.openTime,
  };
}

// ---------- TP / SL discipline from historicalOrders ----------
// For each trade inside the window covered by the order history, look for reduce-only trigger orders
// on the same coin placed while the trade was open. A trigger on the losing side of entry = stop loss,
// on the winning side = take profit. Distances are measured from the average entry.
export function tpslAnalysis(trades, orders, equityAt, cfg = {}) {
  const minStop = cfg.minStopPct ?? 0.0015;
  const maxStop = cfg.maxStopPct ?? 0.12;
  const flat = [];
  for (const o of orders || []) {
    if (o.order) flat.push(o.order);
    for (const c of o.order?.children || []) flat.push(c);
  }
  const triggers = flat.filter((o) => o.isTrigger || /Stop|Take Profit/i.test(o.orderType || ''));
  const byCoin = new Map();
  for (const o of triggers) {
    if (!byCoin.has(o.coin)) byCoin.set(o.coin, []);
    byCoin.get(o.coin).push(o);
  }
  const windowStart = flat.length ? Math.min(...flat.map((o) => o.timestamp)) : Infinity;
  const evaluated = [];
  for (const t of trades) {
    if (t.truncated || !t.entryPx || t.openTime < windowStart) continue;
    const end = t.closeTime ?? Date.now();
    const exitSide = t.side > 0 ? 'A' : 'B';
    const cands = (byCoin.get(t.coin) || []).filter((o) => o.side === exitSide && o.timestamp >= t.openTime - 5 * 60e3 && o.timestamp <= end);
    let sl = null, tp = null;
    for (const o of cands) {
      const trig = num(o.triggerPx);
      if (!trig) continue;
      const dist = ((trig - t.entryPx) / t.entryPx) * t.side; // >0 = profit side
      if (dist < 0 && (sl === null || o.timestamp < sl.ts)) sl = { dist: -dist, ts: o.timestamp };
      if (dist > 0 && (tp === null || o.timestamp < tp.ts)) tp = { dist, ts: o.timestamp };
    }
    const lev = t.maxNotional / equityAt(t.openTime);
    const slSane = sl ? sl.dist >= minStop && sl.dist <= maxStop && sl.dist * Math.max(1, lev) < 0.8 : false;
    evaluated.push({ hasSL: !!sl, hasTP: !!tp, slDist: sl?.dist ?? null, tpDist: tp?.dist ?? null, slSane });
  }
  const n = evaluated.length;
  const withSL = evaluated.filter((e) => e.hasSL);
  const withTP = evaluated.filter((e) => e.hasTP);
  const rr = evaluated.filter((e) => e.hasSL && e.hasTP).map((e) => e.tpDist / e.slDist);
  return {
    evaluated: n,
    windowStart: Number.isFinite(windowStart) ? windowStart : null,
    slCoverage: n ? withSL.length / n : null,
    tpCoverage: n ? withTP.length / n : null,
    saneStopShare: n ? evaluated.filter((e) => e.slSane).length / n : null,
    medianStopPct: withSL.length ? S.median(withSL.map((e) => e.slDist)) : null,
    medianTpPct: withTP.length ? S.median(withTP.map((e) => e.tpDist)) : null,
    medianRR: rr.length ? S.median(rr) : null,
  };
}

// ---------- Funding flows from the non-funding ledger ----------
export function flowAnalysis(ledger, address) {
  const me = address.toLowerCase();
  let bridgeIn = 0, bridgeOut = 0, transfersIn = 0, transfersOut = 0;
  const cps = new Map();
  const bump = (addr, dir, usd) => {
    const a = (addr || '').toLowerCase();
    if (!a || a === me || SYSTEM_ADDRESSES.has(a)) return;
    if (!cps.has(a)) cps.set(a, { address: a, inUsd: 0, outUsd: 0, count: 0 });
    const c = cps.get(a);
    c[dir] += usd;
    c.count++;
  };
  for (const u of ledger || []) {
    const d = u.delta || {};
    switch (d.type) {
      case 'deposit': bridgeIn += num(d.usdc); break;
      case 'withdraw': bridgeOut += num(d.usdc); break;
      case 'internalTransfer':
      case 'subAccountTransfer':
      case 'send':
      case 'spotTransfer': {
        const usd = num(d.usdcValue ?? d.usdc ?? d.amount);
        const from = (d.user || '').toLowerCase();
        const to = (d.destination || '').toLowerCase();
        if (from === to) break; // moving between own perp/spot balances
        if (to === me) { transfersIn += usd; bump(from, 'inUsd', usd); }
        else if (from === me) { transfersOut += usd; bump(to, 'outUsd', usd); }
        break;
      }
      default: break;
    }
  }
  const counterparties = [...cps.values()].sort((a, b) => b.inUsd + b.outUsd - (a.inUsd + a.outUsd));
  return { bridgeIn, bridgeOut, transfersIn, transfersOut, netInflow: bridgeIn + transfersIn - bridgeOut - transfersOut, counterparties: counterparties.slice(0, 10) };
}

// ---------- Live positions ----------
export function parsePositions(states) {
  const out = [];
  let accountValue = 0, totalNtl = 0;
  for (const st of states || []) {
    if (!st) continue;
    accountValue += num(st.marginSummary?.accountValue);
    totalNtl += num(st.marginSummary?.totalNtlPos);
    for (const ap of st.assetPositions || []) {
      const p = ap.position;
      const szi = num(p.szi);
      if (!szi) continue;
      const notional = num(p.positionValue);
      out.push({
        coin: p.coin, szi, side: Math.sign(szi), notional, entryPx: num(p.entryPx), markPx: notional / Math.abs(szi),
        uPnl: num(p.unrealizedPnl), roe: num(p.returnOnEquity), leverage: num(p.leverage?.value), leverageType: p.leverage?.type,
        liqPx: p.liquidationPx ? num(p.liquidationPx) : null, marginUsed: num(p.marginUsed),
      });
    }
  }
  return { accountValue, totalNtl, positions: out };
}

// ---------- Full metric set ----------
export function computeMetrics({ address, fills: allFills, portfolio, orders, ledger, states, nTrials, topK = 1, now = Date.now(), cfg = {} }) {
  const fills = allFills.filter(isPerpFill);
  const live = parsePositions(states);
  const hist = equityHistory(portfolio);
  const equityAt = makeEquityAt(hist, live.accountValue);
  const trades = buildTrades(fills, address);
  const closed = trades.filter((t) => !t.isOpen);
  const events = closingEvents(fills, address);
  const tradeRet = events.map((e) => e.pnl / equityAt(e.time));
  const exposure = exposureProfile(fills, equityAt, now);

  // Daily realized-PnL returns over the analysis window (days with no trading count as 0).
  const firstFill = fills.length ? Math.min(...fills.map((f) => f.time)) : now;
  const startDay = Math.floor(firstFill / DAY) * DAY;
  const endDay = Math.floor(now / DAY) * DAY;
  const dailyPnl = new Map();
  let volume = 0, makerVol = 0;
  const volByClass = {}, pnlByCoin = {}, volByCoin = {};
  for (const f of fills) {
    const d = Math.floor(f.time / DAY) * DAY;
    dailyPnl.set(d, (dailyPnl.get(d) || 0) + num(f.closedPnl) - num(f.fee));
    const ntl = num(f.px) * num(f.sz);
    volume += ntl;
    if (!f.crossed) makerVol += ntl;
    const cls = classify(f.coin);
    volByClass[cls] = (volByClass[cls] || 0) + ntl;
    volByCoin[f.coin] = (volByCoin[f.coin] || 0) + ntl;
    pnlByCoin[f.coin] = (pnlByCoin[f.coin] || 0) + num(f.closedPnl) - num(f.fee);
  }
  const days = [], daily = [];
  for (let d = startDay; d <= endDay; d += DAY) {
    days.push(d);
    daily.push((dailyPnl.get(d) || 0) / equityAt(d));
  }
  // Additive equity index (1 + cumulative daily return): return on a fixed unit of capital. Compounding would let
  // one near-total-loss day (vs. a thin account) wipe the index even when dollar PnL is strongly positive.
  const curve = [];
  let idx = 1;
  for (const r of daily) { idx += r; curve.push(idx); }

  // Calendar months / weeks.
  const months = new Map();
  days.forEach((d, i) => {
    const k = new Date(d).toISOString().slice(0, 7);
    if (!months.has(k)) months.set(k, { month: k, ret: 0, days: 0 });
    const m = months.get(k);
    m.ret += daily[i];
    m.days++;
  });
  const monthly = [...months.values()].map((m) => ({ month: m.month, ret: m.ret, days: m.days }));
  const fullishMonths = monthly.filter((m) => m.days >= 10);
  const weekly = [];
  for (let i = 0; i < daily.length; i += 7) weekly.push(S.sum(daily.slice(i, i + 7)));

  const half = Math.floor(daily.length / 2);
  const wins = events.filter((t) => t.pnl > 0);
  const losses = events.filter((t) => t.pnl < 0);
  const sumWin = S.sum(wins.map((t) => t.pnl));
  const sumLoss = -S.sum(losses.map((t) => t.pnl));
  const totalPnl = S.sum([...dailyPnl.values()]); // realized PnL net of all fees
  const sortedPnl = events.map((t) => t.pnl).sort((a, b) => b - a);
  const topN = Math.max(1, Math.ceil(events.length * 0.01));
  const lev = exposure.levSamples;
  const cleanTrips = closed.filter((t) => !t.truncated);
  // Round-trip hold time when the trader goes flat often enough; otherwise the inventory-turnover estimate.
  const holds = cleanTrips.length >= 15 ? cleanTrips.map((t) => t.holdMs / 3600e3) : [];
  const holdHours = holds.length ? S.median(holds) : exposure.inventoryHoldHours;

  const totalClassVol = S.sum(Object.values(volByClass)) || 1;
  const mix = Object.fromEntries(Object.entries(volByClass).map(([k, v]) => [k, v / totalClassVol]));
  const assetQuality = S.sum(Object.entries(mix).map(([k, s]) => s * (CLASSES[k]?.quality ?? 0.4)));
  const positivePnlCoins = Object.values(pnlByCoin).filter((p) => p > 0);
  const topCoins = Object.entries(volByCoin).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([coin, v]) => ({ coin, share: v / (volume || 1), pnl: pnlByCoin[coin], cls: classify(coin) }));

  const tpsl = tpslAnalysis(trades, orders, equityAt, cfg);
  const flows = flowAnalysis(ledger, address);
  const lastTrade = fills.length ? Math.max(...fills.map((f) => f.time)) : 0;
  const unrealized = S.sum(live.positions.map((p) => p.uPnl));

  const m = {
    address,
    accountValue: live.accountValue,
    currentLeverage: live.accountValue > 0 ? live.totalNtl / live.accountValue : 0,
    openPositions: live.positions.length,
    openPnlPct: live.accountValue > 0 ? unrealized / live.accountValue : 0,

    // sample size / longevity
    nFills: fills.length,
    nTrades: events.length,
    nRoundTrips: closed.length,
    activeDays: dailyPnl.size,
    spanDays: (now - firstFill) / DAY,
    daysSinceLastTrade: lastTrade ? (now - lastTrade) / DAY : Infinity,
    historyStart: hist.length ? hist[0][0] : firstFill,
    tradesPerDay: events.length / Math.max(1, (now - firstFill) / DAY),
    fillsPerDay: fills.length / Math.max(1, (now - firstFill) / DAY),

    // style
    medianHoldHours: holdHours,
    holdMethod: holds.length ? 'round trips' : 'inventory turnover',
    p90HoldHours: holds.length ? S.quantile(holds, 0.9) : null,
    makerShare: volume ? makerVol / volume : 0,

    // volume
    volume,
    medianTradeNotional: events.length ? S.median(events.map((t) => t.notional)) : 0,

    // returns / luck
    totalPnl,
    totalReturn: curve.length ? curve[curve.length - 1] - 1 : 0,
    dailySharpe: S.sharpe(daily),
    annSharpe: S.sharpe(daily) * Math.sqrt(365),
    annSortino: S.sortino(daily) * Math.sqrt(365),
    psr: S.probabilisticSharpe(daily, 0),
    dsr: S.deflatedSharpe(daily, nTrials, topK),
    luckBenchmarkAnnSharpe: S.expectedMaxSharpe(nTrials, daily.length, topK) * Math.sqrt(365),
    tradeSharpe: S.sharpe(tradeRet),
    tradePsr: S.probabilisticSharpe(tradeRet, 0),
    tradeDsr: S.deflatedSharpe(tradeRet, nTrials, topK),
    luckInputs: { daily: S.moments(daily), trade: S.moments(tradeRet) },
    skew: S.skewness(daily),
    kurtosis: S.kurtosis(daily),
    maxDrawdown: S.maxDrawdown([1, ...curve]),
    sharpeFirstHalf: S.sharpe(daily.slice(0, half)) * Math.sqrt(365),
    sharpeSecondHalf: S.sharpe(daily.slice(half)) * Math.sqrt(365),
    positiveMonthShare: fullishMonths.length ? fullishMonths.filter((x) => x.ret > 0).length / fullishMonths.length : null,
    nMonths: fullishMonths.length,
    positiveWeekShare: weekly.length ? weekly.filter((x) => x > 0).length / weekly.length : null,

    // win rate vs payoff
    winRate: events.length ? wins.length / events.length : 0,
    avgWinPct: wins.length ? S.mean(wins.map((t) => t.pnl / equityAt(t.time))) : 0,
    avgLossPct: losses.length ? S.mean(losses.map((t) => t.pnl / equityAt(t.time))) : 0,
    payoffRatio: wins.length && losses.length ? (sumWin / wins.length) / (sumLoss / losses.length) : null,
    profitFactor: sumLoss > 0 ? sumWin / sumLoss : sumWin > 0 ? 99 : 0,
    expectancyPct: tradeRet.length ? S.mean(tradeRet) : 0,
    worstTradePct: tradeRet.length ? Math.min(...tradeRet) : 0,
    p5TradePct: tradeRet.length ? S.quantile(tradeRet, 0.05) : 0,

    // concentration
    topTradeShare: totalPnl > 0 && sortedPnl.length ? sortedPnl[0] / totalPnl : null,
    top1PctTradesShare: totalPnl > 0 ? S.sum(sortedPnl.slice(0, topN)) / totalPnl : null,
    pnlExTop1Pct: totalPnl - S.sum(sortedPnl.slice(0, topN)),
    topCoinPnlShare: positivePnlCoins.length ? Math.max(...positivePnlCoins) / S.sum(positivePnlCoins) : null,

    // leverage / risk
    medianLeverage: lev.length ? S.median(lev) : 0,
    p90Leverage: lev.length ? S.quantile(lev, 0.9) : 0,
    liquidations: events.filter((t) => t.liquidated).length,

    // asset class
    assetMix: mix,
    assetQuality,
    memeShare: mix.meme || 0,
    tradfiShare: S.sum(Object.entries(mix).filter(([k]) => isTradFi(k)).map(([, v]) => v)),
    topCoins,

    tpsl,
    flows,
  };

  const series = {
    days,
    curve,
    accountValue: hist,
    monthly,
  };
  const recentTrades = trades.slice(-150).map((t) => ({
    coin: t.coin, side: t.side, openTime: t.openTime, closeTime: t.closeTime, entryPx: t.entryPx, exitPx: t.exitPx,
    maxNotional: t.maxNotional, netPnl: t.netPnl, retPct: t.netPnl / equityAt(t.openTime), leverage: t.maxNotional / equityAt(t.openTime),
    isOpen: t.isOpen, liquidated: t.liquidated, truncated: t.truncated,
  }));
  return { metrics: m, series, trades: recentTrades, positions: live.positions };
}
