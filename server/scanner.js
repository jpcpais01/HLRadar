// Orchestrates the crawl: leaderboard prefilter -> deep per-wallet analysis -> live tracking of finalists.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { HLClient } from './hl.js';
import { computeMetrics, buildTrades, parsePositions } from './analyze.js';
import { setMeta } from './assets.js';
import { DEFAULT_CONFIG, mergeConfig, rankWallets, evaluateGates } from './filters.js';
import { consensus, tradeEvents, clusterAlerts } from './consensus.js';

const DAY = 86400e3;
const num = (x) => Number(x || 0);
const win = (row, k) => {
  const w = (row.windowPerformances || []).find((x) => x[0] === k);
  return w ? { pnl: num(w[1].pnl), roi: num(w[1].roi), vlm: num(w[1].vlm) } : { pnl: 0, roi: 0, vlm: 0 };
};
const STABLES = new Set(['USDC', 'USDT', 'USDT0', 'USDE', 'USDH', 'USDHL', 'FEUSD']);

export class Scanner {
  constructor({ dataDir = 'data' } = {}) {
    this.dataDir = dataDir;
    this.walletDir = path.join(dataDir, 'wallets');
    this.rawDir = path.join(dataDir, 'raw');
    fs.mkdirSync(this.walletDir, { recursive: true });
    fs.mkdirSync(this.rawDir, { recursive: true });
    this.screened = readJson(path.join(dataDir, 'screened.json')) || {};
    this.funders = readJson(path.join(dataDir, 'funders.json')) || {};
    this.config = mergeConfig(DEFAULT_CONFIG, readJson(path.join(dataDir, 'config.json')));
    this.hl = new HLClient({ cacheDir: path.join(dataDir, 'cache'), weightPerMinute: this.config.scan.weightPerMinute });
    this.universe = readJson(path.join(dataDir, 'universe.json'));
    this.analyses = new Map();
    for (const f of fs.readdirSync(this.walletDir)) {
      const a = readJson(path.join(this.walletDir, f));
      if (a?.metrics) this.analyses.set(a.metrics.address, a);
    }
    this.entities = {};
    this.computeEntities();
    this.live = { updatedAt: 0, positions: {}, fills: {}, openTimes: {}, market: {} };
    this.progress = { phase: 'idle', done: 0, total: 0, current: null, errors: [], startedAt: null };
    this.running = false;
    this.stopRequested = false;
  }

  saveConfig(over) {
    this.config = mergeConfig(DEFAULT_CONFIG, mergeConfig(this.config, over));
    fs.writeFileSync(path.join(this.dataDir, 'config.json'), JSON.stringify(this.config, null, 2));
    return this.config;
  }
  resetConfig() {
    this.config = structuredClone(DEFAULT_CONFIG);
    fs.writeFileSync(path.join(this.dataDir, 'config.json'), JSON.stringify(this.config, null, 2));
    return this.config;
  }

  nTrials() {
    return this.config.nTrialsOverride || this.universe?.sizeQualified || 10000;
  }

  // ---------- Stage 0 ----------
  async refreshUniverse() {
    const u = this.config.universe;
    this.progress = { ...this.progress, phase: 'Downloading leaderboard', current: null };
    const lb = await this.hl.leaderboard();
    const rows = lb.leaderboardRows || [];
    const sized = rows.filter((r) => num(r.accountValue) >= u.minAccountValue && win(r, 'allTime').vlm >= u.minAllTimeVolume);
    const cands = sized.filter((r) => {
      const at = win(r, 'allTime'), mo = win(r, 'month');
      const turnover = mo.vlm / Math.max(1, num(r.accountValue));
      return at.pnl >= u.minAllTimePnl && (!u.requirePositiveMonth || mo.pnl > 0) && turnover <= u.maxMonthlyTurnover;
    }).map((r) => {
      const at = win(r, 'allTime'), mo = win(r, 'month'), wk = win(r, 'week');
      const av = num(r.accountValue);
      // Cheap pre-score: return on capital, recent form, size. Deliberately broad; deep filters do the real work.
      const pre = 0.45 * Math.min(at.roi, 5) / 5 + 0.25 * Math.max(-1, Math.min(mo.roi, 1)) + 0.1 * (wk.pnl >= 0 ? 1 : 0) + 0.2 * Math.min(1, Math.log10(av) / 7);
      return { address: r.ethAddress.toLowerCase(), source: 'leaderboard', displayName: r.displayName, accountValue: av, allTime: at, month: mo, week: wk, pre };
    }).sort((a, b) => b.pre - a.pre);

    let vaultCands = [];
    if (u.includeVaults) {
      this.progress.phase = 'Downloading vaults';
      try {
        const vaults = await this.hl.vaults();
        vaultCands = vaults.filter((v) => !v.summary.isClosed && num(v.summary.tvl) >= u.minVaultTvl && v.summary.relationship?.type !== 'child')
          .map((v) => {
            const at = (v.pnls || []).find((p) => p[0] === 'allTime')?.[1] || [];
            const pnl = num(at[at.length - 1]);
            return { address: v.summary.vaultAddress.toLowerCase(), source: 'vault', displayName: v.summary.name, leader: v.summary.leader, accountValue: num(v.summary.tvl), allTime: { pnl, roi: pnl / Math.max(1, num(v.summary.tvl)), vlm: 0 }, apr: v.apr, pre: 0 };
          })
          .filter((v) => v.allTime.pnl > 0)
          .sort((a, b) => b.allTime.roi - a.allTime.roi)
          .slice(0, 30);
      } catch (e) { this.progress.errors.push(`vaults: ${e.message}`); }
    }
    const selected = cands.slice(0, u.deepScanCount);
    const seen = new Set(selected.map((c) => c.address));
    for (const v of vaultCands) if (!seen.has(v.address)) { selected.push(v); seen.add(v.address); }
    this.universe = {
      fetchedAt: Date.now(), totalRows: rows.length, sizeQualified: sized.length, prefiltered: cands.length,
      candidates: selected, vaultCandidates: vaultCands.length,
    };
    fs.writeFileSync(path.join(this.dataDir, 'universe.json'), JSON.stringify(this.universe));
    return this.universe;
  }

  // ---------- Stage 1: quick screen (portfolio + positions, ~22 weight per wallet) ----------
  // Drops wallets that would fail cheap gates before spending ~600 weight on their fills and orders.
  async quickScreen(c) {
    const g = this.config.gates;
    const [portfolio, state] = await Promise.all([this.hl.portfolio(c.address), this.hl.clearinghouseState(c.address)]);
    const all = (portfolio || []).find((p) => p[0] === 'perpAllTime' || p[0] === 'allTime')?.[1];
    const firstTs = all?.accountValueHistory?.[0]?.[0] ?? Date.now();
    const historyDays = (Date.now() - firstTs) / DAY;
    const av = num(state?.marginSummary?.accountValue);
    const lev = av > 0 ? num(state?.marginSummary?.totalNtlPos) / av : 0;
    const reasons = [];
    if (g.longevity.enabled && historyDays < g.longevity.minDays) reasons.push(`history ${historyDays.toFixed(0)}d`);
    // Cheap luck checks on HL's own (deposit-neutral) PnL history, deliberately looser than the final gates.
    // pnlHistory and accountValueHistory share timestamps; a drawdown is measured against equity at the PnL peak.
    const pnl = (all?.pnlHistory || []).map((p) => num(p[1]));
    const avs = (all?.accountValueHistory || []).map((p) => num(p[1]));
    if (pnl.length > 10 && avs.length === pnl.length) {
      const total = pnl[pnl.length - 1] - pnl[0];
      let peakI = 0, worst = 0, maxJump = 0;
      for (let i = 0; i < pnl.length; i++) {
        if (pnl[i] > pnl[peakI]) peakI = i;
        const eq = Math.max(avs[peakI], 1);
        worst = Math.max(worst, (pnl[peakI] - pnl[i]) / eq);
        if (i) maxJump = Math.max(maxJump, pnl[i] - pnl[i - 1]);
      }
      if (g.concentration.enabled && total > 0 && maxJump / total > 0.7) reasons.push(`${Math.round((100 * maxJump) / total)}% of lifetime PnL in one step`);
      if (g.drawdown.enabled && worst > 0.6) reasons.push(`lost ${Math.round(100 * Math.min(worst, 9.99))}% of equity from a PnL peak`);
    }
    if (g.leverage.enabled && lev > g.leverage.maxCurrentLeverage) reasons.push(`leverage ${lev.toFixed(1)}x now`);
    return { pass: reasons.length === 0, reasons, portfolio };
  }

  // ---------- Stage 2: deep analysis of one wallet ----------
  // pages = 0 fetches only the latest 2000 fills (cheap first pass); `prev` reuses everything but fills.
  async fetchRaw(addr, portfolio, { pages = this.config.scan.maxFillPages, prev = null } = {}) {
    const cfg = this.config.scan;
    const start = Date.now() - cfg.lookbackDays * DAY;
    const fills = await this.hl.fillsSince(addr, start, { maxPages: pages, latest: prev?.fills });
    const [pf, orders, ledger, subs, agents] = prev ? [prev.portfolio, prev.orders, prev.ledger, prev.subs, prev.agents] : await Promise.all([
      portfolio || this.hl.portfolio(addr), this.hl.historicalOrders(addr), this.hl.ledger(addr, Date.now() - 365 * DAY),
      this.hl.subAccounts(addr).catch(() => null), this.hl.extraAgents(addr).catch(() => null),
    ]);
    const dexes = this.dexesFor(fills);
    const states = await Promise.all(dexes.map((d) => this.hl.clearinghouseState(addr, d).catch(() => null)));
    const raw = { addr, fetchedAt: Date.now(), fills, portfolio: pf, orders, ledger, subs, agents, dexes, states };
    // Raw data is kept (gzipped) so analysis changes can be re-run offline: `node server/cli.js reanalyze`.
    fs.writeFileSync(path.join(this.rawDir, `${addr}.json.gz`), zlib.gzipSync(JSON.stringify(raw)));
    return raw;
  }

  // Two passes: a cheap one on the latest 2000 fills; only wallets that pass the style/asset/leverage gates on that
  // sample get the full fill history (which is most of the API cost).
  async analyzeWallet(address, meta = {}, { portfolio, offline = false, twoPass = true } = {}) {
    const addr = address.toLowerCase();
    let raw;
    if (offline) raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(this.rawDir, `${addr}.json.gz`))));
    else if (!twoPass) raw = await this.fetchRaw(addr, portfolio);
    else {
      raw = await this.fetchRaw(addr, portfolio, { pages: 0 });
      const first = this.computeFor(addr, raw, meta, false);
      const cheap = ['active', 'style', 'assetClass', 'leverage', 'openRisk'];
      const ok = evaluateGates(first.metrics, this.config).filter((g) => cheap.includes(g.id) && g.enabled).every((g) => g.pass);
      if (ok && raw.fills.length >= 2000) raw = await this.fetchRaw(addr, portfolio, { prev: raw });
    }
    return this.finishAnalysis(addr, raw, meta, offline);
  }

  computeFor(addr, raw, meta, offline) {
    const { fills, orders, ledger, states } = raw;
        return computeMetrics({ address: addr, fills, portfolio: raw.portfolio, orders, ledger, states, nTrials: this.nTrials(), topK: this.config.finalists.count, now: offline ? raw.fetchedAt : Date.now(), cfg: this.config.gates.riskManagement });
  }

  async finishAnalysis(addr, raw, meta, offline) {
    const { subs, agents, dexes } = raw;
    const res = this.computeFor(addr, raw, meta, offline);
    res.metrics.pro = {
      subAccounts: Array.isArray(subs) ? subs.length : 0,
      apiAgents: Array.isArray(agents) ? agents.filter((a) => !/mobile|qr|app/i.test(a.name || '')).length : 0,
      isVault: meta.source === 'vault',
    };
    // Funding counterparties: how big are the wallets that send money in (or receive it)?
    const prev = this.analyses.get(addr)?.metrics.flows.counterparties || [];
    for (const cp of res.metrics.flows.counterparties.slice(0, this.config.scan.counterpartyLookups)) {
      const old = prev.find((p) => p.address === cp.address);
      if (offline) { cp.value = old?.value; continue; }
      try {
        const [perp, spot] = await Promise.all([this.hl.clearinghouseState(cp.address), this.hl.spotClearinghouseState(cp.address)]);
        const stable = (spot?.balances || []).filter((b) => STABLES.has(b.coin)).reduce((s, b) => s + num(b.total), 0);
        cp.value = num(perp?.marginSummary?.accountValue) + stable;
      } catch { cp.value = null; }
    }
    const out = { ...res, meta, dexes, scannedAt: raw.fetchedAt };
    this.analyses.set(addr, out);
    fs.writeFileSync(path.join(this.walletDir, `${addr}.json`), JSON.stringify(out));
    return out;
  }

  async reanalyzeAll() {
    for (const f of fs.readdirSync(this.rawDir)) {
      const addr = f.replace('.json.gz', '');
      const meta = this.analyses.get(addr)?.meta || this.universe?.candidates.find((c) => c.address === addr) || {};
      try { await this.analyzeWallet(addr, meta, { offline: true }); } catch (e) { console.error(addr, e.message); }
    }
    this.computeEntities();
  }

  dexesFor(fills) {
    const set = new Set(['']);
    for (const f of fills) if (f.coin.includes(':')) set.add(f.coin.split(':')[0]);
    return [...set];
  }

  async runScan({ refreshUniverse = true, maxAgeHours = 24 } = {}) {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.progress = { phase: 'starting', done: 0, total: 0, current: null, errors: [], startedAt: Date.now() };
    try {
      await this.loadMeta();
      if (refreshUniverse || !this.universe) await this.refreshUniverse();
      const todo = this.universe.candidates.filter((c) => {
        const a = this.analyses.get(c.address);
        const sc = this.screened?.[c.address];
        if (sc && Date.now() - sc.at < maxAgeHours * 3600e3) return false;
        return !a || Date.now() - a.scannedAt > maxAgeHours * 3600e3;
      });
      this.progress = { ...this.progress, phase: 'Scanning', total: todo.length, done: 0, screenedOut: 0 };
      this.screened = this.screened || {};
      for (const c of todo) {
        if (this.stopRequested) break;
        this.progress.current = c.address;
        try {
          const q = await this.quickScreen(c);
          if (!q.pass) {
            this.screened[c.address] = { at: Date.now(), reasons: q.reasons };
            this.progress.screenedOut++;
          } else {
            await this.analyzeWallet(c.address, c, { portfolio: q.portfolio });
          }
        } catch (e) { this.progress.errors.push(`${c.address}: ${e.message}`); }
        this.progress.done++;
        if (this.progress.done % 20 === 0) { await this.checkFunders(); this.computeEntities(); }
      }
      await this.checkFunders();
      fs.writeFileSync(path.join(this.dataDir, 'screened.json'), JSON.stringify(this.screened));
      this.computeEntities();
      this.progress.phase = this.stopRequested ? 'stopped' : 'done';
    } catch (e) {
      this.progress.phase = 'error';
      this.progress.errors.push(e.message);
    } finally {
      this.progress.current = null;
      this.running = false;
    }
    this.refreshLive().catch(() => {});
  }

  async loadMeta() {
    const [meta] = await this.hl.metaAndAssetCtxs('', 600e3);
    setMeta(meta.universe);
  }

  // For every wallet that funds 2+ scanned wallets, look at its own transfers: a wallet that pays out to many
  // different addresses is an exchange / bridge / payment hub and must not link traders together.
  async checkFunders() {
    const counts = new Map();
    for (const a of this.analyses.values()) {
      for (const cp of a.metrics.flows.counterparties || []) if (cp.inUsd > 0) counts.set(cp.address, (counts.get(cp.address) || 0) + 1);
    }
    for (const [addr, n] of counts) {
      if (n < 2 || this.funders[addr]) continue;
      try {
        const led = await this.hl.ledger(addr, Date.now() - 30 * DAY);
        const dests = new Set((led || []).filter((u) => (u.delta?.user || '').toLowerCase() === addr).map((u) => (u.delta.destination || '').toLowerCase()));
        this.funders[addr] = { recipients30d: dests.size, hub: dests.size > 15, checkedAt: Date.now() };
      } catch { /* try again next time */ }
    }
    fs.writeFileSync(path.join(this.dataDir, 'funders.json'), JSON.stringify(this.funders));
  }

  // Wallets that fund each other, or share a funder that is not a hub, are treated as one entity.
  computeEntities() {
    const addrs = [...this.analyses.keys()];
    const parent = Object.fromEntries(addrs.map((a) => [a, a]));
    const find = (a) => (parent[a] === a ? a : (parent[a] = find(parent[a])));
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    const funders = new Map();
    for (const a of addrs) {
      for (const cp of this.analyses.get(a).metrics.flows.counterparties || []) {
        if (parent[cp.address] !== undefined) union(a, cp.address);
        if (cp.inUsd > 0) {
          if (!funders.has(cp.address)) funders.set(cp.address, new Set());
          funders.get(cp.address).add(a);
        }
      }
    }
    for (const [funder, set] of funders) {
      if (set.size < 2 || this.funders[funder]?.hub !== false || set.size > 6) continue; // unknown or hub: don't link
      const [first, ...rest] = [...set];
      rest.forEach((r) => union(first, r));
    }
    const groups = {};
    for (const a of addrs) (groups[find(a)] ||= []).push(a);
    this.entities = {};
    for (const [root, members] of Object.entries(groups)) for (const m of members) this.entities[m] = members.length > 1 ? root : m;
  }

  // ---------- Ranking ----------
  ranking() {
    const list = [...this.analyses.values()].map((a) => ({ ...a, entity: this.entities[a.metrics.address] || a.metrics.address }));
    return rankWallets(list, this.config, this.nTrials());
  }

  // ---------- Stage 3: live tracking of finalists ----------
  async refreshLive() {
    const { finalists } = this.ranking();
    const since = Date.now() - this.config.signals.freshHours * 3600e3;
    const positions = {}, fills = {}, openTimes = {};
    for (const f of finalists) {
      const addr = f.metrics.address;
      try {
        const states = await Promise.all((f.dexes || ['']).map((d) => this.hl.clearinghouseState(addr, d).catch(() => null)));
        const live = parsePositions(states);
        positions[addr] = live.positions;
        f.metrics.accountValue = live.accountValue || f.metrics.accountValue;
        const recent = await this.hl.info({ type: 'userFillsByTime', user: addr, startTime: since, aggregateByTime: true });
        fills[addr] = Array.isArray(recent) ? recent : [];
        // When was each open position opened? Prefer a fresh opening fill, else the analysed open trade.
        openTimes[addr] = {};
        for (const t of f.trades.filter((x) => x.isOpen)) openTimes[addr][t.coin] = t.openTime;
        for (const t of buildTrades(fills[addr], addr).filter((x) => x.isOpen && !x.truncated)) openTimes[addr][t.coin] = t.openTime;
      } catch (e) { this.progress.errors.push(`live ${addr}: ${e.message}`); }
    }
    const market = {};
    for (const dex of new Set(finalists.flatMap((f) => f.dexes || ['']))) {
      try {
        const [meta, ctxs] = await this.hl.metaAndAssetCtxs(dex);
        meta.universe.forEach((a, i) => {
          const c = ctxs[i];
          market[a.name] = { mark: num(c.markPx), prev: num(c.prevDayPx), funding: num(c.funding), oi: num(c.openInterest), vlm: num(c.dayNtlVlm) };
        });
      } catch { /* market context is optional */ }
    }
    this.live = { updatedAt: Date.now(), positions, fills, openTimes, market };
    return this.live;
  }

  consensusView() {
    const { finalists } = this.ranking();
    const w = this.config.extended?.weight ?? 0.5;
    const info = Object.fromEntries(finalists.map((f) => [f.metrics.address, { address: f.metrics.address, score: f.tier === 'extended' ? f.score * w : f.score, rawScore: f.score, tier: f.tier, entity: f.entity, accountValue: f.metrics.accountValue }]));
    const cons = consensus(Object.values(info), this.live.positions, this.live.openTimes, this.config.signals);
    const events = tradeEvents(this.live.fills, info, this.config.signals);
    const alerts = clusterAlerts(events, this.config.signals);
    for (const r of cons.rows) {
      const m = this.live.market[r.coin];
      if (m) Object.assign(r, { mark: m.mark, change24h: m.prev ? m.mark / m.prev - 1 : null, funding: m.funding });
    }
    return { ...cons, events, alerts, updatedAt: this.live.updatedAt };
  }
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
