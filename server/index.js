// HTTP server: JSON API + static dashboard. No dependencies, Node 18+.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Scanner } from './scanner.js';
import { GATE_INFO, SCORE_WEIGHTS, DEFAULT_CONFIG } from './filters.js';
import { CLASSES } from './assets.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 8787);
const scanner = new Scanner({ dataDir: process.env.HL_DATA_DIR || path.join(root, 'data') });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  let s = '';
  for await (const chunk of req) s += chunk;
  return s ? JSON.parse(s) : {};
}

// Compact row for tables (full detail comes from /api/wallet/:addr).
function summary(r) {
  const m = r.metrics;
  return {
    address: m.address, entity: r.entity, source: r.meta?.source, name: r.meta?.displayName, score: r.score, failed: r.failed,
    accountValue: m.accountValue, totalPnl: m.totalPnl, totalReturn: m.totalReturn, annSharpe: m.annSharpe, dsr: m.dsr, tradeDsr: m.tradeDsr,
    maxDrawdown: m.maxDrawdown, nTrades: m.nTrades, winRate: m.winRate, profitFactor: m.profitFactor, medianHoldHours: m.medianHoldHours,
    medianLeverage: m.medianLeverage, assetMix: m.assetMix, tradfiShare: m.tradfiShare, memeShare: m.memeShare, slCoverage: m.tpsl.slCoverage,
    positiveMonthShare: m.positiveMonthShare, volume: m.volume, openPositions: m.openPositions, scannedAt: r.scannedAt,
  };
}

const routes = {
  'GET /api/status': () => ({
    progress: scanner.progress, running: scanner.running,
    universe: scanner.universe && { fetchedAt: scanner.universe.fetchedAt, totalRows: scanner.universe.totalRows, sizeQualified: scanner.universe.sizeQualified, prefiltered: scanner.universe.prefiltered, candidates: scanner.universe.candidates.length },
    analysed: scanner.analyses.size, nTrials: scanner.nTrials(), liveUpdatedAt: scanner.live.updatedAt, api: scanner.hl.stats,
  }),
  'GET /api/meta': () => ({ gates: GATE_INFO, weights: SCORE_WEIGHTS, classes: CLASSES, defaults: DEFAULT_CONFIG }),
  'GET /api/config': () => scanner.config,
  'POST /api/config': async (req) => scanner.saveConfig(await readBody(req)),
  'POST /api/config/reset': () => scanner.resetConfig(),
  'GET /api/ranking': () => {
    const { rows, finalists, funnel } = scanner.ranking();
    const universe = scanner.universe;
    return {
      funnel: [
        ...(universe ? [
          { id: 'leaderboard', label: 'Leaderboard wallets', layer: 'Universe', remaining: universe.totalRows },
          { id: 'size', label: 'Size & volume (these count as "trials")', layer: 'Universe', remaining: universe.sizeQualified },
          { id: 'prefilter', label: 'Profitable, not HFT', layer: 'Universe', remaining: universe.prefiltered },
        ] : []),
        { id: 'deep', label: 'Deep-scanned', layer: 'Universe', remaining: rows.length },
        ...funnel,
      ],
      finalists: finalists.map(summary),
      rows: rows.map(summary),
    };
  },
  'GET /api/consensus': () => scanner.consensusView(),
  'POST /api/scan/start': async (req) => {
    const body = await readBody(req);
    scanner.runScan({ refreshUniverse: body.refreshUniverse !== false, maxAgeHours: body.maxAgeHours ?? 24 });
    return { started: true };
  },
  'POST /api/scan/stop': () => { scanner.stopRequested = true; return { stopping: true }; },
  'POST /api/live/refresh': async () => { await scanner.refreshLive(); return { updatedAt: scanner.live.updatedAt }; },
};

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const key = `${req.method} ${url.pathname}`;
  try {
    if (routes[key]) return send(res, 200, await routes[key](req));
    let m = url.pathname.match(/^\/api\/wallet\/(0x[0-9a-fA-F]{40})$/);
    if (m && req.method === 'GET') {
      const addr = m[1].toLowerCase();
      const { rows } = scanner.ranking();
      const r = rows.find((x) => x.metrics.address === addr);
      if (!r) return send(res, 404, { error: 'not analysed yet' });
      return send(res, 200, { ...r, rank: rows.indexOf(r) + 1, live: scanner.live.positions[addr] || r.positions });
    }
    m = url.pathname.match(/^\/api\/wallet\/(0x[0-9a-fA-F]{40})\/scan$/);
    if (m && req.method === 'POST') {
      await scanner.loadMeta();
      const a = await scanner.analyzeWallet(m[1], { source: 'manual' });
      await scanner.checkFunders();
      scanner.computeEntities();
      return send(res, 200, { ok: true, address: a.metrics.address });
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    // static
    const file = path.join(root, 'public', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(path.join(root, 'public'))) return send(res, 403, { error: 'forbidden' });
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}

http.createServer(handle).listen(PORT, () => {
  console.log(`HL Radar running at http://localhost:${PORT}`);
  console.log(`  ${scanner.analyses.size} wallets already analysed in ${scanner.dataDir}`);
});

// Keep finalists' positions fresh.
const LIVE_MS = Number(process.env.HL_LIVE_MS || 120000);
setInterval(() => { if (!scanner.running) scanner.refreshLive().catch((e) => console.error('live refresh:', e.message)); }, LIVE_MS);
if (scanner.analyses.size) scanner.refreshLive().catch(() => {});
if (process.env.HL_AUTOSCAN === '1' || (!scanner.analyses.size && process.env.HL_AUTOSCAN !== '0')) scanner.runScan();
