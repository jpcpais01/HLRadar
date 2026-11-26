import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrades, closingEvents, exposureProfile, tpslAnalysis, flowAnalysis, computeMetrics } from '../server/analyze.js';
import * as S from '../server/stats.js';
import { classify } from '../server/assets.js';
import { DEFAULT_CONFIG, rankWallets, evaluateGates } from '../server/filters.js';
import { consensus, tradeEvents, clusterAlerts } from '../server/consensus.js';
import { markToMarket, mergeCandles, neededPriceRanges } from '../server/mtm.js';

const H = 3600e3, D = 24 * H;
let tid = 1;
// Make a fill. side: 'B' buy / 'A' sell; start: position before the fill.
function fill(coin, side, sz, px, time, start, closedPnl = 0, extra = {}) {
  const after = start + (side === 'B' ? sz : -sz);
  let dir;
  if (start === 0) dir = side === 'B' ? 'Open Long' : 'Open Short';
  else if (start > 0) dir = after < 0 ? 'Long > Short' : side === 'B' ? 'Open Long' : 'Close Long';
  else dir = after > 0 ? 'Short > Long' : side === 'A' ? 'Open Short' : 'Close Short';
  return { coin, side, sz: String(sz), px: String(px), time, startPosition: String(start), dir, closedPnl: String(closedPnl), fee: '0.5', crossed: true, tid: tid++, ...extra };
}

test('stats: normal cdf/inverse round-trip and Sharpe', () => {
  for (const p of [0.01, 0.2, 0.5, 0.9, 0.999]) assert.ok(Math.abs(S.normCdf(S.normInv(p)) - p) < 1e-4);
  assert.ok(Math.abs(S.sharpe([1, 2, 3]) - 2) < 1e-9);
  assert.equal(S.maxDrawdown([1, 2, 1, 3]), 0.5);
});

test('stats: luck benchmark grows with number of wallets screened, shrinks with track length', () => {
  assert.ok(S.expectedMaxSharpe(10000, 180) > S.expectedMaxSharpe(100, 180));
  assert.ok(S.expectedMaxSharpe(10000, 360) < S.expectedMaxSharpe(10000, 180));
  // Top-25 benchmark is easier to beat than the single luckiest wallet.
  assert.ok(S.expectedMaxSharpe(10000, 180, 25) < S.expectedMaxSharpe(10000, 180, 1));
});

test('stats: deflated Sharpe punishes a lucky-looking record that PSR accepts', () => {
  // 60 days, daily mean 0.4%, sd 2% -> annual Sharpe ~3.8
  const r = Array.from({ length: 60 }, (_, i) => 0.004 + 0.02 * Math.sin(i * 1.7));
  assert.ok(S.probabilisticSharpe(r) > 0.9);
  assert.ok(S.deflatedSharpe(r, 8000) < 0.2);
});

test('round trips: open, add, partial close, close, flip', () => {
  const t0 = Date.UTC(2026, 0, 1);
  const fills = [
    fill('BTC', 'B', 1, 100, t0, 0),
    fill('BTC', 'B', 1, 110, t0 + H, 1),
    fill('BTC', 'A', 1, 120, t0 + 2 * H, 2, 15),
    fill('BTC', 'A', 1, 130, t0 + 3 * H, 1, 25),
    fill('ETH', 'A', 2, 50, t0, 0),
    fill('ETH', 'B', 3, 40, t0 + 5 * H, -2, 20), // flip short -> long 1
  ];
  const trades = buildTrades(fills, '0xabc');
  const btc = trades.find((t) => t.coin === 'BTC');
  assert.equal(btc.side, 1);
  assert.equal(btc.entryPx, 105);
  assert.equal(btc.pnl, 40);
  assert.equal(btc.holdMs, 3 * H);
  const eth = trades.filter((t) => t.coin === 'ETH');
  assert.equal(eth.length, 2);
  assert.equal(eth[0].side, -1);
  assert.equal(eth[0].isOpen, false);
  assert.equal(eth[1].side, 1);
  assert.equal(eth[1].isOpen, true);
});

test('closing events group reducing fills and ignore spot', () => {
  const t0 = Date.UTC(2026, 0, 1);
  const evs = closingEvents([
    fill('SOL', 'B', 10, 100, t0, 0),
    fill('SOL', 'A', 5, 110, t0 + H, 10, 50),
    fill('SOL', 'A', 5, 111, t0 + H + 60e3, 5, 55),
    { coin: 'PURR/USDC', side: 'A', sz: '1', px: '1', time: t0, dir: 'Sell', closedPnl: '5', fee: '0' },
  ]);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].pnl, 105 - 1);
});

test('inventory-turnover hold time for a trader who never goes flat', () => {
  const t0 = Date.UTC(2026, 0, 1);
  // Holds ~10 BTC-units for 4 days, closing 5 then re-adding 5 each day -> hold ~ 2 days.
  const fills = [fill('BTC', 'B', 10, 100, t0, 0)];
  let pos = 10;
  for (let d = 1; d <= 4; d++) {
    fills.push(fill('BTC', 'A', 5, 100, t0 + d * D, pos, 0)); pos -= 5;
    fills.push(fill('BTC', 'B', 5, 100, t0 + d * D + 1, pos)); pos += 5;
  }
  const { inventoryHoldHours } = exposureProfile(fills, () => 1000, t0 + 4 * D + 1);
  assert.ok(Math.abs(inventoryHoldHours - 48) < 1, String(inventoryHoldHours));
});

test('TP/SL detection: stop below entry for a long, take-profit above', () => {
  const t0 = Date.now() - 10 * D;
  const trades = buildTrades([fill('ETH', 'B', 1, 1000, t0, 0), fill('ETH', 'A', 1, 1050, t0 + H, 1, 50)]);
  const orders = [
    { order: { coin: 'ETH', side: 'A', triggerPx: '970', isTrigger: true, orderType: 'Stop Market', timestamp: t0 + 1000, children: [] }, status: 'canceled' },
    { order: { coin: 'ETH', side: 'A', triggerPx: '1050', isTrigger: true, orderType: 'Take Profit Market', timestamp: t0 + 2000, children: [] }, status: 'filled' },
    { order: { coin: 'ETH', side: 'B', limitPx: '1000', isTrigger: false, orderType: 'Limit', timestamp: t0 - 1000, children: [] }, status: 'filled' },
  ];
  const r = tpslAnalysis(trades, orders, () => 10000);
  assert.equal(r.evaluated, 1);
  assert.equal(r.slCoverage, 1);
  assert.equal(r.tpCoverage, 1);
  assert.ok(Math.abs(r.medianStopPct - 0.03) < 1e-9);
  assert.equal(r.saneStopShare, 1);
});

test('funding flows: counterparties exclude self-transfers and system address', () => {
  const me = '0x00000000000000000000000000000000000000aa';
  const f = flowAnalysis([
    { delta: { type: 'deposit', usdc: '1000' } },
    { delta: { type: 'send', user: '0xbbb', destination: me, usdcValue: '500' } },
    { delta: { type: 'send', user: me, destination: me, usdcValue: '700' } },
    { delta: { type: 'spotTransfer', user: '0x2222222222222222222222222222222222222222', destination: me, usdcValue: '9' } },
    { delta: { type: 'withdraw', usdc: '300' } },
  ], me);
  assert.equal(f.bridgeIn, 1000);
  assert.equal(f.bridgeOut, 300);
  assert.equal(f.transfersIn, 509);
  assert.deepEqual(f.counterparties.map((c) => c.address), ['0xbbb']);
});

test('asset classes', () => {
  assert.equal(classify('xyz:NVDA'), 'equity');
  assert.equal(classify('xyz:XYZ100'), 'index');
  assert.equal(classify('xyz:GOLD'), 'commodity');
  assert.equal(classify('BTC'), 'major');
  assert.equal(classify('kPEPE'), 'meme');
  assert.equal(classify('SOL'), 'largecap');
});

// --- end to end on synthetic wallets: a disciplined trader passes, a lucky gambler doesn't ---
function synthWallet({ seed, days, tradesPerDay, edge, riskPct, coin, lev, now }) {
  let x = seed;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  const fills = [], orders = [];
  const equity = 100000;
  const start = now - days * D;
  for (let i = 0; i < days * tradesPerDay; i++) {
    const t = start + (i / tradesPerDay) * D + rnd() * 3600e3;
    const px = 100;
    const side = rnd() > 0.5 ? 1 : -1;
    const notional = equity * lev;
    const sz = notional / px;
    const win = rnd() < 0.5 + edge;
    const pnl = (win ? 1.5 : -1) * equity * riskPct * (0.5 + rnd());
    fills.push(fill(coin, side > 0 ? 'B' : 'A', sz, px, t, 0));
    fills.push(fill(coin, side > 0 ? 'A' : 'B', sz, px + (pnl / sz) * side, t + 6 * H, side * sz, pnl));
    orders.push({ order: { coin, side: side > 0 ? 'A' : 'B', triggerPx: String(px * (1 - side * 0.02)), isTrigger: true, orderType: 'Stop Market', timestamp: t + 1000, children: [] }, status: 'canceled' });
  }
  const portfolio = [['allTime', { accountValueHistory: [[start - 30 * D, String(equity)], [now, String(equity)]], pnlHistory: [] }]];
  const states = [{ marginSummary: { accountValue: String(equity), totalNtlPos: '0' }, assetPositions: [] }];
  return { fills, orders, portfolio, states, ledger: [] };
}

test('end to end: disciplined trader becomes a finalist, gambler is rejected', () => {
  const now = Date.now();
  const good = synthWallet({ seed: 7, days: 150, tradesPerDay: 2, edge: 0.12, riskPct: 0.004, coin: 'xyz:XYZ100', lev: 2, now });
  const bad = synthWallet({ seed: 11, days: 150, tradesPerDay: 0.3, edge: 0.1, riskPct: 0.2, coin: 'kPEPE', lev: 25, now });
  const a = computeMetrics({ address: '0x' + '1'.repeat(40), ...good, nTrials: 5000, topK: 25, now });
  const b = computeMetrics({ address: '0x' + '2'.repeat(40), ...bad, nTrials: 5000, topK: 25, now });
  const { finalists, rows } = rankWallets([{ ...a, meta: {}, entity: 'a' }, { ...b, meta: {}, entity: 'b' }], DEFAULT_CONFIG, 5000);
  const gatesA = evaluateGates(a.metrics, DEFAULT_CONFIG).filter((g) => g.enabled && !g.pass).map((g) => g.id);
  assert.deepEqual(gatesA, [], `good trader failed: ${gatesA}`);
  assert.equal(finalists.length, 1);
  assert.equal(finalists[0].metrics.address, a.metrics.address);
  const badRow = rows.find((r) => r.metrics.address === b.metrics.address);
  assert.ok(badRow.failed.includes('assetClass'));
  assert.ok(badRow.failed.includes('leverage'));
});

// Hourly candles at a flat price, with optional dips (t0 -> {l, h, c}) to simulate open-position pain.
function flatCandles(from, to, px, dips = new Map()) {
  const out = [];
  for (let t = Math.floor(from / H) * H; t < to; t += H) out.push({ t, T: t + H - 1, o: px, h: px, l: px, c: px, ...(dips.get(t) || {}) });
  return out;
}

test('mark to market: a long that sinks 40% of equity and is closed green is a rescued bag', () => {
  const t0 = Date.UTC(2026, 0, 1);
  const fills = [fill('BTC', 'B', 10, 100, t0, 0), fill('BTC', 'A', 10, 101, t0 + 48 * H, 10, 10)];
  const dips = new Map();
  for (let k = 10; k < 30; k++) dips.set(t0 + k * H, { l: 60, c: 62 });
  const prices = new Map([['BTC', flatCandles(t0, t0 + 50 * H, 100, dips)]]);
  const x = markToMarket({ fills, prices, equityAt: () => 1000, now: t0 + 60 * H });
  assert.ok(Math.abs(x.worstMaePct - -0.4) < 1e-3, `mae ${x.worstMaePct}`); // incl. the opening fee
  assert.ok(x.worstOpenLossPct <= -0.38);
  assert.ok(x.mtmMaxDrawdown > 0.35);
  assert.equal(x.bagTrades, 1);
  assert.equal(x.rescuedBags, 1);
  assert.ok(x.priceCoverage > 0.99);
  // The same trade with a tight stop: small MAE, nothing rescued.
  const stopped = [fill('BTC', 'B', 10, 100, t0, 0), fill('BTC', 'A', 10, 97, t0 + 3 * H, 10, -30)];
  const y = markToMarket({ fills: stopped, prices, equityAt: () => 1000, now: t0 + 60 * H });
  assert.ok(y.worstMaePct > -0.04 && y.rescuedBags === 0, JSON.stringify(y));
});

test('mark to market: candle merging and needed ranges', () => {
  const t0 = Date.UTC(2026, 0, 1);
  const c4 = [0, 1, 2].map((i) => ({ t: t0 + i * 4 * H, T: t0 + (i + 1) * 4 * H - 1, h: '2', l: '1', c: '1.5' }));
  const c1 = [8, 9].map((i) => ({ t: t0 + i * H, T: t0 + (i + 1) * H - 1, h: '2', l: '1', c: '1.5' }));
  const m = mergeCandles(c1, c4);
  assert.deepEqual(m.map((x) => x.t), [t0, t0 + 4 * H, t0 + 8 * H, t0 + 9 * H]);
  const r = neededPriceRanges([fill('ETH', 'B', 1, 10, t0, 0), fill('ETH', 'A', 1, 10, t0 + 60e3, 1), fill('SOL', 'B', 1, 10, t0, 0), fill('SOL', 'A', 1, 10, t0 + 5 * H, 1)], t0 + 10 * H);
  assert.ok(!r.has('ETH'));
  assert.deepEqual(r.get('SOL'), [t0, t0 + 5 * H]);
});

test('bag holder with a perfect realized record is rejected; same trader cutting losses passes', () => {
  const now = Date.now();
  const w = synthWallet({ seed: 7, days: 150, tradesPerDay: 2, edge: 0.12, riskPct: 0.004, coin: 'xyz:XYZ100', lev: 2, now });
  const opens = w.fills.filter((f) => f.dir.startsWith('Open'));
  const clean = new Map([['xyz:XYZ100', flatCandles(now - 151 * D, now, 100)]]);
  // Every 10th trade first sinks 15% against the position (30% of equity at 2x) before coming back.
  const dips = new Map();
  opens.forEach((f, i) => {
    if (i % 10) return;
    const long = f.side === 'B';
    for (let t = Math.ceil(f.time / H) * H + H; t + H < f.time + 6 * H; t += H) dips.set(t, long ? { l: 85, c: 86 } : { h: 115, c: 114 });
  });
  const pain = new Map([['xyz:XYZ100', flatCandles(now - 151 * D, now, 100, dips)]]);
  const a = computeMetrics({ address: '0x' + '1'.repeat(40), ...w, nTrials: 5000, topK: 25, now, prices: clean });
  const b = computeMetrics({ address: '0x' + '2'.repeat(40), ...w, nTrials: 5000, topK: 25, now, prices: pain });
  assert.equal(a.metrics.maxDrawdown, b.metrics.maxDrawdown); // realized stats can't tell them apart
  const fa = evaluateGates(a.metrics, DEFAULT_CONFIG).filter((g) => g.enabled && !g.pass).map((g) => g.id);
  const fb = evaluateGates(b.metrics, DEFAULT_CONFIG).filter((g) => g.enabled && !g.pass).map((g) => g.id);
  assert.deepEqual(fa, []);
  assert.deepEqual(fb, ['bagHolding']);
  assert.ok(b.metrics.mtm.rescuedBags > 2 && b.metrics.mtm.worstMaePct < -0.25);
});

test('consensus: entities dedupe, agreement and cluster alerts', () => {
  const now = Date.now();
  const finalists = [
    { address: 'a', score: 80, entity: 'A', accountValue: 1e6 },
    { address: 'a2', score: 70, entity: 'A', accountValue: 1e6 }, // same trader, second wallet
    { address: 'b', score: 60, entity: 'b', accountValue: 1e6 },
    { address: 'c', score: 50, entity: 'c', accountValue: 1e6 },
  ];
  const pos = (coin, side, n) => ({ coin, side, notional: n, szi: side * n / 100, entryPx: 100, markPx: 100, uPnl: 0 });
  const positions = { a: [pos('BTC', 1, 5e5)], a2: [pos('BTC', 1, 5e5)], b: [pos('BTC', 1, 2e5)], c: [pos('BTC', -1, 1e5), pos('ETH', 1, 1e5)] };
  const c = consensus(finalists, positions, {}, {});
  const btc = c.rows.find((r) => r.coin === 'BTC');
  assert.equal(c.nEntities, 3);
  assert.equal(btc.nLong, 2); // A counted once
  assert.equal(btc.nShort, 1);
  assert.equal(btc.bias, 'LONG');
  assert.ok(btc.strength > 0);
  assert.equal(c.rows.find((r) => r.coin === 'ETH').strength, 0); // single holder

  const f = (coin, dir, t, sz) => ({ coin, dir, time: t, px: '100', sz: String(sz), closedPnl: '0', side: 'B' });
  const events = tradeEvents({ a: [f('SOL', 'Open Long', now - H, 5000)], b: [f('SOL', 'Open Long', now - 2 * H, 3000)], c: [f('SOL', 'Close Short', now - H, 10)] },
    Object.fromEntries(finalists.map((x) => [x.address, x])), {});
  assert.equal(events.length, 3);
  assert.ok(events.find((e) => e.address === 'a').big);
  const alerts = clusterAlerts(events, {});
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].coin, 'SOL');
  assert.equal(alerts[0].entities, 2);
});

test('open loss far beyond anything ever closed fails "not hiding losses"', () => {
  const now = Date.now();
  const w = synthWallet({ seed: 7, days: 150, tradesPerDay: 2, edge: 0.12, riskPct: 0.004, coin: 'xyz:XYZ100', lev: 2, now });
  const a = computeMetrics({ address: '0x' + '1'.repeat(40), ...w, nTrials: 5000, topK: 25, now });
  const gate = (m) => evaluateGates(m, DEFAULT_CONFIG).find((g) => g.id === 'openRisk').pass;
  assert.ok(gate({ ...a.metrics, openPnlPct: -0.02 }));
  assert.ok(!gate({ ...a.metrics, openPnlPct: -0.207 })); // worst closed trade is under 1%: -20.7% open is a bag
  assert.ok(gate({ ...a.metrics, openPnlPct: -0.12, worstTradePct: -0.1 })); // a big swing trader can sit at -12%
  assert.ok(!gate({ ...a.metrics, openPnlPct: -0.3, worstTradePct: -0.1 }));
});
