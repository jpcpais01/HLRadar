# HL Radar

Find Hyperliquid traders who look **skilled rather than lucky**, then watch what they hold together.

HL Radar crawls Hyperliquid's public data (leaderboard, vaults, fills, orders, transfers, positions), pushes every candidate wallet through a stack of filters designed to separate real edge from survivorship and luck, and turns the survivors ("finalists") into a dashboard of consensus positions, clustered entries and big new trades.

It does not place trades.

## Quick start

Requires Node.js 18.17+ (no npm dependencies).

```bash
npm start            # http://localhost:8787
```

On first start with an empty `data/` folder it begins a scan automatically. The scan respects Hyperliquid's API rate limit (1200 weight/min per IP; we use 1000), so the first full pass over ~630 candidates takes a few hours (about 60% are rejected by the cheap quick screen). Results appear in the dashboard as wallets are analysed. Later scans skip wallets analysed in the last 24h.

Other commands:

```bash
npm run scan -- 100                 # headless scan of the top 100 candidates, prints funnel + finalists
node server/cli.js reanalyze        # recompute all metrics from saved raw data (no network)
npm test                            # unit + synthetic end-to-end tests
```

Environment variables: `PORT` (default 8787), `HL_DATA_DIR` (default `./data`), `HL_AUTOSCAN` (`1` always scan on start, `0` never), `HL_LIVE_MS` (finalist position refresh, default 120000). Behind an HTTPS proxy on Node 22+, set `NODE_USE_ENV_PROXY=1`.

## The dashboard

| Tab | What it shows |
|---|---|
| **Signals** | Consensus per asset across finalists: long/short split, skill-weighted agreement, breadth, position size vs equity, fresh entries, open PnL, 24h move, funding and a 0-100 signal score. Plus **clustered entries**: two or more independent finalists opening the same side of the same asset recently |
| **Finalists** | The filter funnel (how many wallets survive each gate) and the ranked finalists, plus near misses that failed exactly one gate |
| **Trade feed** | Finalists' fills from the last 48h grouped into trades, with big trades flagged |
| **All scanned** | Every deep-scanned wallet and which gates it failed. Paste any address to analyse it |
| **Filters** | The methodology, and every threshold, editable. Saving re-ranks instantly from cached data |

Click any wallet for its full profile: realized equity curve, monthly returns, each gate with its numbers, skill-score breakdown, asset mix, stop-loss stats, funding counterparties, open positions and recent trades.

## How the filtering works

Short version: ~48k leaderboard wallets → size/volume/profit prefilter → cheap screen → deep scan → **15 hard gates** in three layers → survivors ranked by a skill score → up to 25 core + 100 extended finalists.

1. **Data & style**: enough trades, ≥ 60 days of history, still active, intraday to few-day holding period (rejects market makers and HODLers), serious volume.
2. **Your filters**: not a memecoin gambler (TradFi and majors rewarded), uses stop-losses at sane distances, optionally funded by large wallets.
3. **Skill vs luck**: **Deflated Sharpe Ratio** (Sharpe judged against what the luckiest of ~8,000 zero-skill traders would show), consistency across months plus a first-half vs second-half out-of-sample check, drawdown cap, profit not from one trade, healthy win/payoff (no "picking up pennies"), sane leverage with no liquidations, and no large hidden open losses.

Wallets that fund each other are merged into one trader, so one person with several wallets can't fake a consensus.

The full explanation, with every threshold and the formulas, is in **[docs/FILTERS.md](docs/FILTERS.md)**.

## Code map

```
server/hl.js          Hyperliquid API client: weight-based rate limiter, retries, disk cache
server/analyze.js     Pure analysis: round trips, closing events, TP/SL detection, flows, metrics
server/stats.js       Sharpe, Sortino, PSR, Deflated Sharpe, drawdown, normal cdf/inverse
server/assets.js      Asset-class classification (incl. HIP-3 markets like xyz:NVDA)
server/filters.js     Default config, the 15 gates, skill score, funnel
server/consensus.js   Consensus per asset, trade events, clustered-entry alerts
server/scanner.js     Orchestration: universe -> quick screen -> two-pass deep scan -> live tracking
server/index.js       HTTP server (JSON API + static dashboard)
public/               Dashboard (vanilla JS + SVG charts, no build step)
test/                 node:test suite
```

Data lives in `data/` (git-ignored): `universe.json`, `wallets/*.json` (computed analyses), `raw/*.json.gz` (raw API data for offline re-analysis), `config.json` (your threshold overrides).

## Caveats

This is a research tool. Strong historical stats reduce, but never remove, the chance that a wallet was lucky, and the edge of a real winner can decay or be front-run. Copying positions also means copying them late. See "Known limits" in [docs/FILTERS.md](docs/FILTERS.md).
