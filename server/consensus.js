// Aggregates finalists' live positions and recent fills into consensus views and signals.
import { classify } from './assets.js';
import { median } from './stats.js';

const num = (x) => Number(x || 0);

// finalists: [{address, score, entity, accountValue}]; positions: {address: [{coin, side, notional, entryPx, markPx, uPnl, leverage}]}
// openTimes: {address: {coin: ms}} when the current position was opened (from fills), optional.
export function consensus(finalists, positions, openTimes = {}, cfg = {}) {
  const freshMs = (cfg.freshHours ?? 48) * 3600e3;
  const now = Date.now();
  // Collapse wallets of the same entity (e.g. funded by the same wallet) so one trader with 3 accounts counts once.
  const entities = new Map();
  for (const f of finalists) {
    const key = f.entity || f.address;
    if (!entities.has(key)) entities.set(key, { key, wallets: [], weight: 0, equity: 0 });
    const e = entities.get(key);
    e.wallets.push(f);
    e.weight = Math.max(e.weight, f.score / 100);
    e.equity += Math.max(0, f.accountValue || 0);
  }
  const totalWeight = [...entities.values()].reduce((s, e) => s + e.weight, 0) || 1;

  const byCoin = new Map();
  for (const e of entities.values()) {
    const perCoin = new Map();
    for (const w of e.wallets) {
      for (const p of positions[w.address] || []) {
        if (!perCoin.has(p.coin)) perCoin.set(p.coin, { signedNtl: 0, uPnl: 0, cost: 0, opened: null, wallets: [] });
        const c = perCoin.get(p.coin);
        c.signedNtl += p.side * p.notional;
        c.uPnl += p.uPnl;
        c.cost += p.entryPx * Math.abs(p.szi || p.notional / (p.markPx || 1));
        c.wallets.push(w.address);
        const ot = openTimes[w.address]?.[p.coin];
        if (ot && (!c.opened || ot > c.opened)) c.opened = ot;
      }
    }
    for (const [coin, c] of perCoin) {
      if (!c.signedNtl) continue;
      if (!byCoin.has(coin)) byCoin.set(coin, { coin, cls: classify(coin), holders: [] });
      byCoin.get(coin).holders.push({
        entity: e.key, wallets: c.wallets, weight: e.weight, side: Math.sign(c.signedNtl), notional: Math.abs(c.signedNtl),
        exposure: Math.abs(c.signedNtl) / Math.max(1, e.equity), uPnl: c.uPnl, opened: c.opened,
        fresh: c.opened ? now - c.opened <= freshMs : false,
      });
    }
  }

  const rows = [];
  for (const r of byCoin.values()) {
    const h = r.holders;
    const wIn = h.reduce((s, x) => s + x.weight, 0);
    const wSigned = h.reduce((s, x) => s + x.weight * x.side, 0);
    const longs = h.filter((x) => x.side > 0);
    const shorts = h.filter((x) => x.side < 0);
    const direction = wIn ? wSigned / wIn : 0; // -1..1, agreement among holders
    const breadth = wIn / totalWeight; // share of finalist skill-weight in this coin
    const conviction = median(h.map((x) => x.exposure)); // typical position size as multiple of equity
    const freshShare = wIn ? h.filter((x) => x.fresh).reduce((s, x) => s + x.weight, 0) / wIn : 0;
    const independent = Math.max(longs.length, shorts.length);
    const strength = independent >= 2
      ? 100 * Math.abs(direction) * Math.sqrt(breadth) * (0.6 + 0.4 * freshShare) * Math.min(1, conviction / 0.5) ** 0.3
      : 0;
    rows.push({
      coin: r.coin, cls: r.cls, nLong: longs.length, nShort: shorts.length,
      longNotional: longs.reduce((s, x) => s + x.notional, 0), shortNotional: shorts.reduce((s, x) => s + x.notional, 0),
      direction, breadth, conviction, freshShare, uPnl: h.reduce((s, x) => s + x.uPnl, 0),
      strength, label: strength >= 40 ? 'strong' : strength >= 20 ? 'moderate' : strength > 0 ? 'weak' : 'single holder',
      bias: direction > 0.2 ? 'LONG' : direction < -0.2 ? 'SHORT' : 'MIXED',
      holders: h,
    });
  }
  rows.sort((a, b) => b.strength - a.strength || b.longNotional + b.shortNotional - (a.longNotional + a.shortNotional));
  return { rows, nEntities: entities.size, nWallets: finalists.length };
}

// Group recent fills into trade events: consecutive fills of one wallet in one coin and direction, < 30 min apart.
export function tradeEvents(fillsByAddress, finalistInfo, cfg = {}) {
  const events = [];
  for (const [address, fills] of Object.entries(fillsByAddress)) {
    const info = finalistInfo[address] || {};
    const sorted = [...fills].sort((a, b) => a.time - b.time);
    let cur = null;
    const flush = () => { if (cur) events.push(cur); cur = null; };
    for (const f of sorted) {
      if (f.coin.startsWith('@')) continue;
      // posSide = side of the position being opened or closed (+1 long, -1 short); a flip counts as opening the new side.
      const kind = /^Open|>/.test(f.dir) ? 'open' : /^Close/.test(f.dir) ? 'close' : 'other';
      if (kind === 'other') continue;
      const posSide = /Open Short|Close Short|Long > Short/.test(f.dir) ? -1 : 1;
      const key = `${f.coin}|${kind}|${posSide}`;
      if (!cur || cur.key !== key || f.time - cur.lastTime > 30 * 60e3) {
        flush();
        cur = { key, address, entity: info.entity || address, score: info.score, coin: f.coin, cls: classify(f.coin), kind, side: posSide,
          time: f.time, lastTime: f.time, notional: 0, qty: 0, pnl: 0, fills: 0, flip: f.dir.includes('>') };
      }
      const n = num(f.px) * num(f.sz);
      cur.notional += n;
      cur.qty += num(f.sz);
      cur.pnl += num(f.closedPnl);
      cur.fills++;
      cur.lastTime = f.time;
      cur.avgPx = cur.notional / cur.qty;
    }
    flush();
  }
  for (const e of events) {
    const eq = finalistInfo[e.address]?.accountValue || 0;
    e.equityPct = eq > 0 ? e.notional / eq : null;
    e.big = e.notional >= (cfg.bigTradeUsd ?? 250000) || (e.equityPct ?? 0) >= (cfg.bigTradeEquityPct ?? 0.25);
    delete e.key;
  }
  return events.sort((a, b) => b.time - a.time);
}

// Two or more independent finalists opening the same coin in the same direction within the fresh window.
export function clusterAlerts(events, cfg = {}) {
  const freshMs = (cfg.freshHours ?? 48) * 3600e3;
  const now = Date.now();
  const groups = new Map();
  for (const e of events) {
    if (e.kind !== 'open' || now - e.time > freshMs) continue;
    const k = `${e.coin}|${e.side}`;
    if (!groups.has(k)) groups.set(k, { coin: e.coin, side: e.side, cls: e.cls, entities: new Set(), notional: 0, first: e.time, last: e.time, events: [] });
    const g = groups.get(k);
    g.entities.add(e.entity);
    g.notional += e.notional;
    g.first = Math.min(g.first, e.time);
    g.last = Math.max(g.last, e.time);
    g.events.push(e);
  }
  return [...groups.values()].filter((g) => g.entities.size >= 2)
    .map((g) => ({ ...g, entities: g.entities.size }))
    .sort((a, b) => b.entities - a.entities || b.notional - a.notional);
}
