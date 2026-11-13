# How HL Radar separates skill from luck

## The problem

The Hyperliquid leaderboard has roughly 50,000 wallets. About 8,000 of them have real size (≥ $25k equity and ≥ $10M lifetime volume). If every one of those traders had **zero** skill and simply flipped coins, the luckiest few hundred would still show records that look brilliant: high Sharpe, smooth curves, big profits. Sorting the leaderboard by PnL mostly finds those lucky wallets, plus a few gamblers riding one huge trade.

So HL Radar never trusts a single number. A wallet has to pass a series of independent checks, each of which a lucky wallet fails with good probability, and only wallets passing **all** of them become finalists. The idea is the same as the one you described: each filter is imperfect, but stacked together they concentrate the real winners.

## Pipeline

```
~48k leaderboard wallets
  └─ Stage 0  Universe prefilter (free; uses the leaderboard file)
       └─ Stage 1  Quick screen (cheap API calls: portfolio + positions)
            └─ Stage 2  Deep scan (fills, orders, transfers; ~800 API weight per wallet)
                 └─ 15 hard gates  ──►  survivors ranked by skill score  ──►  top 25 finalists
                                                                                   └─ Stage 3  live positions & fills → consensus + signals
```

### Stage 0: universe prefilter

Applied to every leaderboard row:

| Rule | Default | Why |
|---|---|---|
| Account value | ≥ $25k | Skin in the game; also makes positions worth copying |
| All-time volume | ≥ $10M | Real activity |
| All-time PnL | ≥ $10k | Must be a winner to be worth testing |
| This month's PnL | > 0 | Still working now |
| Monthly volume / equity | ≤ 800x | Above that is market-making / HFT, which is not copyable |

The wallets that pass the **size and volume** rules (not the PnL rules) are counted as the number of **trials**, N. That is the population we implicitly searched, and it drives the luck correction below.

The best 600 by a broad pre-score (return on capital, recent form, size) plus up to 30 profitable vaults are sent on. Vaults are included because they are literally small funds running on Hyperliquid.

### Stage 1: quick screen

Two light calls per wallet (portfolio history + current positions) reject, before spending heavy API weight:

* less than 60 days of history, or more than 15x leverage right now;
* more than 70% of lifetime PnL made in a single step of Hyperliquid's own PnL history (one lucky trade);
* losing more than 60% of the account's equity (measured at the PnL peak) from a PnL peak. On the first real scan this alone removed about 60% of the high-ROI candidates, which is exactly the "got lucky after blowing up" profile.

These are deliberately looser than the final gates. Wallets that survive get a first pass on their latest 2,000 fills; only those that also pass the style, asset-class, leverage and open-loss gates on that sample have their full fill history downloaded (that is most of the API cost).

### Stage 2: deep scan and the 15 gates

For each surviving wallet we download up to 8,000 recent fills, the last 2,000 orders, all transfers, and current positions on every perp dex it trades (including HIP-3 markets like `xyz:NVDA`). Raw data is saved, so metrics can be recomputed offline.

Two units of "a trade" are used:

* **Round trip**: position leaves zero and returns to zero. Used for stop-loss analysis.
* **Closing event**: a burst of reducing fills in one coin (gaps under 1 hour). Many good traders never go fully flat, they scale in and out, so round trips undercount their decisions. Closing events are the unit for win rate, payoff, concentration and per-trade Sharpe.

Daily returns are **realized PnL net of fees ÷ account value at that time**, using Hyperliquid's own account-value history. That makes them independent of deposits and withdrawals. The equity index and drawdown are built additively (1 + cumulative daily return, i.e. return on a fixed unit of capital), so one terrible day against a thin account can't zero out an otherwise profitable record.

#### Layer 1: data and style

| Gate | Default | Why |
|---|---|---|
| Enough trades | ≥ 40 closing events, ≥ 20 active days | Smaller samples cannot separate skill from noise |
| Track record length | ≥ 60 days | Lucky streaks are usually short |
| Still active | last trade ≤ 14 days ago | We want to copy wallets trading now |
| Intraday / few-day style | median hold 15 min to 7 days, ≤ 50 closes/day, ≤ 400 fills/day | Your target style. Rejects market makers / HFT and long-term holders. Hold time is the median round trip, or inventory ÷ closing rate for traders who never go flat |
| Serious volume | ≥ $2M in the window, median trade ≥ $5k | Real capital and conviction |

#### Layer 2: your filters

| Gate | Default | Why |
|---|---|---|
| Not a memecoin gambler | memecoins ≤ 35% of volume | Memecoin PnL is dominated by lottery-like jumps. Asset quality also feeds the score: indices, equities, commodities and FX score 1.0, BTC/ETH 0.9, large caps 0.65, alts 0.4, small caps 0.25, memes 0.1 |
| Cuts losses ("Uses stops, sanely") | worst trade ≥ −15% of equity, worst 5% of trades ≥ −4% each; stop-order coverage optional (default 0) | For each trade covered by the order history we look for a trigger order on the exit side placed while it was open; on the losing side of entry it is a stop. "Sane" means 0.15% to 12% from entry and inside the liquidation distance (stop × leverage < 80%). On the first real scan most profitable wallets placed stop orders on under 10% of trades (they exit manually or with limit orders), so requiring stop orders removed almost everyone. Stop usage therefore feeds the score (12%), and the hard gate checks what actually matters, realized loss control. Raise `minStopCoverage` to make stop orders mandatory |
| Funded by a large wallet (**off by default**) | a funding counterparty with ≥ $1M on HL | We check the HL balances of the biggest wallets that sent money in or received money out. Off by default because most money arrives via the Arbitrum bridge, which hides the original source; it still feeds the "professional" part of the score |

#### Layer 3: skill vs luck

| Gate | Default | Why |
|---|---|---|
| Beats the luck benchmark | Deflated Sharpe ≥ 0.5 (daily or per-trade) and PSR ≥ 0.95 | See below |
| Consistent over time | ≥ 60% of months positive (or ≥ 55% of weeks if under 3 months), and positive Sharpe in **both halves** of the history | Consistency, plus an out-of-sample check: a strategy that worked only in one half is likely luck or a regime it no longer fits |
| Controlled drawdown | max drawdown ≤ 35% | Gamblers who got lucky usually show deep drawdowns first |
| Not one lucky trade | best trade ≤ 30% of total profit; still profitable without the best 1% of trades | Kills "one moonshot" records while still allowing positively skewed trend-following |
| Healthy win/payoff mix | profit factor ≥ 1.15, and not win rate > 85% with payoff < 0.25 | The second pattern ("picking up pennies in front of a steamroller") looks great until one loss wipes it out |
| Sane leverage, no liquidations | p90 gross exposure ≤ 15x equity, current ≤ 15x, 0 *material* liquidations (costing ≥ 2% of equity) | Leverage turns noise into huge PnL both ways; a real liquidation is a risk-management failure. On the first scan 45% of wallets had some liquidation, but two thirds of those were tiny isolated side positions, so only material ones count |
| Not hiding losses | open PnL ≥ −25% of equity | Realized stats look great if you never close losers |

### The luck test (Deflated Sharpe Ratio)

1. **Probabilistic Sharpe Ratio (PSR)**: the probability that the wallet's true Sharpe is above zero, given how many observations it has and how skewed and fat-tailed its returns are (Bailey & López de Prado, 2012). Fat tails and few observations lower it.
2. **The luck benchmark**: if N traders with zero skill each produce T observations, their measured Sharpe ratios scatter around zero with standard deviation ≈ 1/√T. Since we keep a shortlist of k = 25 out of N ≈ 8,000, the relevant benchmark is the Sharpe the 25th-luckiest of them would show: `SR* = Φ⁻¹(1 − k/(N+1)) / √(T−1)`. With 180 daily observations that is an annualized Sharpe of about 3.9; with a year of data, about 2.7.
3. **Deflated Sharpe Ratio (DSR)**: PSR measured against SR* instead of zero. DSR = 0.5 means the wallet is about as good as the luckiest of the coin-flippers we would have shortlisted anyway; higher means increasingly unlikely to be luck.

The test runs on two series and passes if either does: daily returns (few observations, measures the whole book) and per-trade returns (many observations, which is where an active intraday trader's evidence lives).

N and k come from settings (`nTrialsOverride`, `finalists.count`), and DSR is recomputed whenever they change.

## Core and extended finalists

A shortlist of 5-10 wallets makes a thin consensus. So there are two tiers:

* **Core**: passes every strict gate above.
* **Extended**: misses a strict gate, but passes slightly looser versions of the *statistical* gates: Deflated Sharpe ≥ 0.15 (PSR ≥ 0.85), ≥ 50% positive months/weeks, worst-5% trades ≥ −6%, worst trade ≥ −20%, best trade ≤ 40% of profit, profit factor ≥ 1.1, ≥ 30 trades, median hold up to 14 days, volume ≥ $1M. The **safety rules are not relaxed**: leverage, material liquidations, memecoins, max drawdown, open losses, activity and history length stay exactly as strict.

Extended finalists count half (`extended.weight`) in the consensus. Both tiers are configurable in `extended` in the settings.

The luck benchmark uses the total shortlist size (core + extended, k = 125 by default), because that's how many wallets we're picking.

## Skill score (ranking the survivors)

| Component | Weight | 0 → 1 mapping |
|---|---|---|
| Luck (avg of daily and per-trade DSR) | 22% | as is |
| Consistency (positive months or weeks) | 14% | 40% → 0, 90% → 1 |
| Discipline (stop coverage, sane stops, worst trade) | 12% | blend; neutral when stop data is missing |
| Risk-adjusted return (annual Sortino) | 10% | 0 → 0, 5 → 1 |
| Asset quality | 10% | volume-weighted class quality above |
| Drawdown | 8% | 0% → 1, 50% → 0 |
| Payoff (profit factor) | 8% | 1.0 → 0, 2.5 → 1 |
| Sample size | 6% | log scale, 500 closes → 1 |
| Leverage | 5% | 0x → 1, 20x → 0 |
| Professional signals | 5% | vault, sub-accounts, API trading agents, $1M+ funding counterparty |

## Independent traders

One person running four wallets should not look like a four-trader consensus. Wallets are merged into one **entity** when they transfer money to each other, or share a funding wallet. Before linking through a shared funder, we download that funder's own transfers: if it paid more than 15 different wallets in the last 30 days it is an exchange, bridge or payment hub (one such address paid 800+ wallets in two weeks) and does not link anyone.

## Consensus and signals

Computed from finalists' live positions, refreshed every 2 minutes:

* **Bias / agreement**: skill-weighted share of holders on each side (−1 all short, +1 all long).
* **Breadth**: share of total finalist skill-weight holding the asset.
* **Size**: median position notional ÷ holder equity.
* **Fresh**: share of holder weight that opened within the last 48h.
* **Signal (0-100)**: `100 × |agreement| × √breadth × (0.6 + 0.4 × fresh) × min(1, size/0.5)^0.3`. It is 0 unless at least 2 independent traders hold the same side. ≥ 40 is labelled strong, ≥ 20 moderate.
* **Clustered entries**: 2 or more independent finalists opening the same asset in the same direction within the window. This is the closest thing to a trade signal on the dashboard.
* **Big trades**: grouped fills of at least $250k, or at least 25% of the wallet's equity.

## Known limits

* Hyperliquid only returns the latest 10,000 fills and 2,000 orders per wallet, so very active traders are judged on a shorter window, and stop-loss usage on recent trades only.
* Realized-PnL returns ignore funding payments and open PnL (open PnL is checked separately by the "not hiding losses" gate).
* Bridge deposits do not reveal the source wallet on Arbitrum. Following that would need an Arbitrum RPC or indexer, which is a natural next step.
* Asset classification uses curated lists plus each market's max leverage; new listings default to "alt" until the lists are updated in `server/assets.js`.
* Survivorship: wallets that blew up and left don't appear on the leaderboard. This makes the leaderboard look better than reality, which is one more reason to keep the luck benchmark strict.
* Past skill is not a guarantee. The dashboard is a research tool, not a trading bot.
