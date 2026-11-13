// The filter "orchestra": hard gates (pass/fail with a reason) + a skill score used to rank survivors.
// Gates only read precomputed metrics, so changing thresholds in the UI re-ranks instantly without refetching.
import { clamp, expectedMaxSharpe, psrFromMoments } from './stats.js';

export const DEFAULT_CONFIG = {
  // ---- Stage 0: leaderboard prefilter (cheap, runs on every wallet in the leaderboard) ----
  universe: {
    minAccountValue: 25000,
    minAllTimeVolume: 10e6,
    minAllTimePnl: 10000,
    requirePositiveMonth: true,
    maxMonthlyTurnover: 800, // month volume / account value; above this is market-making / HFT territory
    deepScanCount: 250, // how many prefiltered wallets get the full (rate-limited) analysis
    includeVaults: true, // vault leaders are literally small funds on HL
    minVaultTvl: 100000,
  },
  // ---- Deep scan ----
  scan: {
    lookbackDays: 180,
    maxFillPages: 4, // x2000 fills
    weightPerMinute: 1000, // HL allows 1200/min per IP
    counterpartyLookups: 3, // largest funding counterparties checked per wallet
  },
  // ---- Hard gates ----
  gates: {
    sample: { enabled: true, minTrades: 40, minActiveDays: 20 },
    longevity: { enabled: true, minDays: 60 },
    active: { enabled: true, maxDaysSinceLastTrade: 14 },
    style: { enabled: true, minMedianHoldHours: 0.25, maxMedianHoldHours: 168, maxTradesPerDay: 50, maxFillsPerDay: 400 },
    volume: { enabled: true, minVolume: 2e6, minMedianTradeNotional: 5000 },
    assetClass: { enabled: true, maxMemeShare: 0.35 },
    // Stop orders: on real data most profitable HL wallets exit manually, so stop-order usage feeds the score by
    // default and the hard gate is on realized loss control. Raise minStopCoverage to require stop orders.
    riskManagement: { enabled: true, minStopCoverage: 0, minSaneStopShare: 0, minEvaluatedTrades: 10, worstTradeFloor: -0.15, p5TradeFloor: -0.04 },
    funding: { enabled: false, minCounterpartyValue: 1e6 },
    luck: { enabled: true, minDeflatedSharpe: 0.5, minPsr: 0.95 },
    consistency: { enabled: true, minPositiveMonthShare: 0.6, minPositiveWeekShare: 0.55, requireBothHalvesPositive: true },
    drawdown: { enabled: true, maxDrawdown: 0.35 },
    concentration: { enabled: true, maxTopTradeShare: 0.3, requirePositiveExTop1Pct: true },
    payoff: { enabled: true, minProfitFactor: 1.15 },
    leverage: { enabled: true, maxP90Leverage: 15, maxCurrentLeverage: 15, maxLiquidations: 0 },
    openRisk: { enabled: true, minOpenPnlPct: -0.25 },
  },
  finalists: { count: 25 },
  // Number of "trials" for multiple-testing correction. 0 = use number of wallets that passed the size/volume prefilter.
  nTrialsOverride: 0,
  signals: { bigTradeUsd: 250000, bigTradeEquityPct: 0.25, freshHours: 48 },
};

export const GATE_INFO = {
  sample: { layer: 'Data & style', label: 'Enough trades', short: 'sample', why: 'Fewer than ~40 closing trades (or 20 active days) is too small a sample to tell skill from noise.' },
  longevity: { layer: 'Data & style', label: 'Track record length', short: 'history', why: 'A few lucky weeks are common; surviving months of regime changes is not.' },
  active: { layer: 'Data & style', label: 'Still active', short: 'inactive', why: 'We want to copy wallets that are trading now.' },
  style: { layer: 'Data & style', label: 'Intraday / few-day style', short: 'style', why: 'Median hold between 15 min and 7 days. Rejects market makers/HFT (not copyable) and long-term holders.' },
  volume: { layer: 'Data & style', label: 'Serious volume', short: 'volume', why: 'Large, sustained volume means real capital and real conviction, and filters out dust accounts.' },
  assetClass: { layer: 'Your filters', label: 'Not a memecoin gambler', short: 'memes', why: 'Memecoin PnL is dominated by lottery-like jumps. Equities, indices, commodities and majors reward analysis more.' },
  riskManagement: { layer: 'Your filters', label: 'Uses stops, sanely', short: 'stops', why: 'Losses are cut: no single trade lost more than 15% of equity and the worst 5% of trades lose under 4% each. Stop orders placed while a trade was open (at a distance that is neither noise-tight nor past liquidation) raise the score; set a minimum stop coverage to make them mandatory.' },
  funding: { layer: 'Your filters', label: 'Funded by a large wallet', short: 'funding', why: 'At least one on-HL funding counterparty holds over $1M. Off by default: most deposits arrive through the bridge, which hides the source.' },
  luck: { layer: 'Skill vs luck', label: 'Beats the luck benchmark', short: 'luck', why: 'Deflated Sharpe Ratio: the probability that the Sharpe ratio beats what the luckiest zero-skill wallets would show, given how many wallets we screened, the shortlist size, fat tails and track length. Uses daily and per-trade returns; either can pass.' },
  consistency: { layer: 'Skill vs luck', label: 'Consistent over time', short: 'consistency', why: 'Most months (or weeks) profitable, and profitable in both halves of the history, an out-of-sample check.' },
  drawdown: { layer: 'Skill vs luck', label: 'Controlled drawdown', short: 'drawdown', why: 'Gamblers who later got lucky usually show deep drawdowns first.' },
  concentration: { layer: 'Skill vs luck', label: 'Not one lucky trade', short: 'one trade', why: 'Biggest trade under 30% of profit, and still profitable after removing the best 1% of trades.' },
  payoff: { layer: 'Skill vs luck', label: 'Healthy win/payoff mix', short: 'payoff', why: 'Profit factor above 1.15, and not the "picking up pennies" pattern (very high win rate with rare huge losses).' },
  leverage: { layer: 'Skill vs luck', label: 'Sane leverage, no liquidations', short: 'leverage', why: 'Huge leverage turns noise into huge PnL both ways; a liquidation is a risk-management failure.' },
  openRisk: { layer: 'Skill vs luck', label: 'Not hiding losses', short: 'open loss', why: 'Realized stats look great if you never close losers. Rejects wallets sitting on a large open loss.' },
};

const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const f2 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? 'n/a' : x.toFixed(2));

export function evaluateGates(m, cfg) {
  const g = cfg.gates;
  const out = [];
  const add = (id, pass, detail, note) => out.push({ id, ...GATE_INFO[id], enabled: g[id]?.enabled !== false, pass, detail, note });

  add('sample', m.nTrades >= g.sample.minTrades && m.activeDays >= g.sample.minActiveDays, `${m.nTrades} trades, ${m.activeDays} active days`);
  const histDays = Math.max(m.spanDays, (Date.now() - (m.historyStart || Date.now())) / 86400e3);
  add('longevity', histDays >= g.longevity.minDays, `${histDays.toFixed(0)} days of history`);
  add('active', m.daysSinceLastTrade <= g.active.maxDaysSinceLastTrade, `last trade ${f2(m.daysSinceLastTrade)} days ago`);
  add('style', m.medianHoldHours !== null && m.medianHoldHours >= g.style.minMedianHoldHours && m.medianHoldHours <= g.style.maxMedianHoldHours && m.tradesPerDay <= g.style.maxTradesPerDay && (m.fillsPerDay ?? 0) <= (g.style.maxFillsPerDay ?? Infinity),
    `median hold ${f2(m.medianHoldHours)}h (${m.holdMethod || 'round trips'}), ${f2(m.tradesPerDay)} closes/day, ${f2(m.fillsPerDay)} fills/day`);
  add('volume', m.volume >= g.volume.minVolume && m.medianTradeNotional >= g.volume.minMedianTradeNotional,
    `$${(m.volume / 1e6).toFixed(1)}M volume, median trade $${Math.round(m.medianTradeNotional).toLocaleString()}`);
  add('assetClass', m.memeShare <= g.assetClass.maxMemeShare, `memes ${pct(m.memeShare)}, TradFi ${pct(m.tradfiShare)} of volume`);

  const t = m.tpsl;
  const enoughOrders = t.evaluated >= g.riskManagement.minEvaluatedTrades;
  const stopsOk = !enoughOrders || (t.slCoverage >= g.riskManagement.minStopCoverage && t.saneStopShare >= g.riskManagement.minSaneStopShare);
  add('riskManagement', stopsOk && m.worstTradePct >= g.riskManagement.worstTradeFloor && m.p5TradePct >= (g.riskManagement.p5TradeFloor ?? -1),
    enoughOrders ? `stops on ${pct(t.slCoverage)} of ${t.evaluated} recent trades (sane ${pct(t.saneStopShare)}, median ${pct(t.medianStopPct)} away); worst trade ${pct(m.worstTradePct)}, worst-5% ${pct(m.p5TradePct)}`
      : `only ${t.evaluated} trades covered by order history; worst trade ${pct(m.worstTradePct)}, worst-5% ${pct(m.p5TradePct)}`,
    enoughOrders ? null : 'Stop usage not judged: not enough order history');

  const bigCp = (m.flows.counterparties || []).filter((c) => (c.value || 0) >= g.funding.minCounterpartyValue);
  add('funding', bigCp.length > 0, bigCp.length ? `${bigCp.length} funding counterparties above $${(g.funding.minCounterpartyValue / 1e6).toFixed(1)}M` : 'no large on-HL funding counterparty found');

  const luckPass = (m.dsr >= g.luck.minDeflatedSharpe || m.tradeDsr >= g.luck.minDeflatedSharpe) && Math.max(m.psr, m.tradePsr) >= g.luck.minPsr;
  add('luck', luckPass, `DSR daily ${f2(m.dsr)}, per-trade ${f2(m.tradeDsr)}; Sharpe ${f2(m.annSharpe)} vs luck benchmark ${f2(m.luckBenchmarkAnnSharpe)}`);

  const useMonths = m.nMonths >= 3;
  const consPass = (useMonths ? m.positiveMonthShare >= g.consistency.minPositiveMonthShare : (m.positiveWeekShare ?? 0) >= g.consistency.minPositiveWeekShare)
    && (!g.consistency.requireBothHalvesPositive || (m.sharpeFirstHalf > 0 && m.sharpeSecondHalf > 0));
  add('consistency', consPass, `${useMonths ? `${pct(m.positiveMonthShare)} of ${m.nMonths} months` : `${pct(m.positiveWeekShare)} of weeks`} positive; Sharpe 1st half ${f2(m.sharpeFirstHalf)}, 2nd half ${f2(m.sharpeSecondHalf)}`);
  add('drawdown', m.maxDrawdown <= g.drawdown.maxDrawdown, `max drawdown ${pct(m.maxDrawdown)}`);
  add('concentration', m.totalPnl > 0 && (m.topTradeShare ?? 1) <= g.concentration.maxTopTradeShare && (!g.concentration.requirePositiveExTop1Pct || m.pnlExTop1Pct > 0),
    `best trade = ${pct(m.topTradeShare)} of profit; PnL without top 1% of trades $${Math.round(m.pnlExTop1Pct).toLocaleString()}`);
  const pennies = m.winRate > 0.85 && m.payoffRatio !== null && m.payoffRatio < 0.25;
  add('payoff', m.profitFactor >= g.payoff.minProfitFactor && !pennies, `profit factor ${f2(m.profitFactor)}, win rate ${pct(m.winRate)}, payoff ${f2(m.payoffRatio)}${pennies ? ' (pennies pattern)' : ''}`);
  add('leverage', m.p90Leverage <= g.leverage.maxP90Leverage && m.currentLeverage <= g.leverage.maxCurrentLeverage && m.liquidations <= g.leverage.maxLiquidations,
    `p90 trade leverage ${f2(m.p90Leverage)}x, now ${f2(m.currentLeverage)}x, ${m.liquidations} liquidations`);
  add('openRisk', m.openPnlPct >= g.openRisk.minOpenPnlPct, `open PnL ${pct(m.openPnlPct)} of equity`);
  return out;
}

// Skill score 0-100: weighted blend of normalized components. Each component is 0..1.
export const SCORE_WEIGHTS = {
  luck: 0.22, riskAdjusted: 0.1, consistency: 0.14, drawdown: 0.08, payoff: 0.08,
  discipline: 0.12, assetQuality: 0.1, sample: 0.06, leverage: 0.05, professional: 0.05,
};

export function scoreComponents(m) {
  const t = m.tpsl;
  const disc = t.evaluated >= 10
    ? 0.5 * (t.slCoverage ?? 0) + 0.3 * (t.saneStopShare ?? 0) + 0.2 * clamp(1 + m.worstTradePct / 0.15, 0, 1)
    : 0.35 + 0.3 * clamp(1 + m.worstTradePct / 0.15, 0, 1); // unknown stop usage: neutral-ish
  const cons = m.nMonths >= 3 ? m.positiveMonthShare : m.positiveWeekShare ?? 0;
  const pro = clamp(
    (m.pro?.subAccounts > 0 ? 0.3 : 0) + (m.pro?.apiAgents > 0 ? 0.3 : 0) + (m.pro?.isVault ? 0.4 : 0)
    + ((m.flows.counterparties || []).some((c) => (c.value || 0) >= 1e6) ? 0.3 : 0), 0, 1);
  return {
    luck: clamp(0.5 * m.dsr + 0.5 * m.tradeDsr, 0, 1),
    riskAdjusted: clamp(m.annSortino / 5, 0, 1),
    consistency: clamp(((cons ?? 0) - 0.4) / 0.5, 0, 1),
    drawdown: clamp(1 - m.maxDrawdown / 0.5, 0, 1),
    payoff: clamp((m.profitFactor - 1) / 1.5, 0, 1),
    discipline: clamp(disc, 0, 1),
    assetQuality: clamp(m.assetQuality, 0, 1),
    sample: clamp(Math.log(1 + m.nTrades) / Math.log(500), 0, 1),
    leverage: clamp(1 - m.p90Leverage / 20, 0, 1),
    professional: pro,
  };
}

export function skillScore(m) {
  const c = scoreComponents(m);
  return 100 * Object.entries(SCORE_WEIGHTS).reduce((s, [k, w]) => s + w * c[k], 0);
}

// DSR depends on N (wallets screened) and k (shortlist size), which are settings, so recompute it here.
export function applyLuck(m, nTrials, topK) {
  const li = m.luckInputs;
  if (!li) return;
  const bD = expectedMaxSharpe(nTrials, li.daily.T, topK);
  const bT = expectedMaxSharpe(nTrials, li.trade.T, topK);
  m.dsr = psrFromMoments(li.daily, bD);
  m.tradeDsr = psrFromMoments(li.trade, bT);
  m.luckBenchmarkAnnSharpe = bD * Math.sqrt(365);
  m.tradeLuckBenchmark = bT;
}

export function rankWallets(analyses, cfg, nTrials = 10000) {
  for (const a of analyses) applyLuck(a.metrics, nTrials, cfg.finalists.count);
  const rows = analyses.map((a) => {
    const gates = evaluateGates(a.metrics, cfg);
    const failed = gates.filter((g) => g.enabled && !g.pass);
    return { ...a, gates, failed: failed.map((g) => g.id), score: skillScore(a.metrics), components: scoreComponents(a.metrics) };
  });
  rows.sort((a, b) => a.failed.length - b.failed.length || b.score - a.score);
  const passing = rows.filter((r) => r.failed.length === 0);
  const finalists = passing.slice(0, cfg.finalists.count);
  // Funnel: wallets surviving each enabled gate, applied in order.
  const funnel = [];
  let alive = rows;
  for (const id of Object.keys(GATE_INFO)) {
    if (cfg.gates[id]?.enabled === false) continue;
    alive = alive.filter((r) => r.gates.find((g) => g.id === id).pass);
    funnel.push({ id, label: GATE_INFO[id].label, layer: GATE_INFO[id].layer, remaining: alive.length });
  }
  return { rows, finalists, funnel };
}

export function mergeConfig(base, over) {
  if (!over || typeof over !== 'object') return structuredClone(base);
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') out[k] = mergeConfig(base[k], v);
    else if (k in base) out[k] = v;
  }
  return out;
}
