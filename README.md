# autolevels

A DE30 (Germany 40) zone strategy in three parts that share one strategy engine (`src/core/`):

| Stage | What | Status |
| --- | --- | --- |
| 1 | Backtester for CSV price files + TradingView overlay | done |
| 2 | Cloudflare agent on IG **demo**, **signals only** (paper trades, no orders) | done — deploy below |
| 3 | Real orders on IG (Germany 40 Cash €1, size 0.01) | done — switch is OFF until you turn it on |

## Stage 3: real trading

Settings are in `wrangler.toml` (deployed automatically from GitHub):

| Setting | Now | Meaning |
| --- | --- | --- |
| `TRADE_EPIC` | `IX.D.DAX.INE.IP` | Germany 40 Cash (€1 per point at size 1) |
| `TRADE_SIZE` | `0.01` | €0.01 per point: a 30-point stop risks about €0.30 |
| `GUARANTEED_STOP` | `true` | loss stops exactly at the stop; IG charges a 2-point premium if hit |
| `MAX_TRADES_PER_DAY` | `5` | no new orders after this many trades in a day |
| `MAX_DAILY_LOSS_POINTS` | `250` | no new orders after losing this many points in a day |
| `MAX_DAILY_LOSS_PERCENT` | `5` | no new orders after losing this % of the day's starting balance (balance + open P&L as IG reports it, account currency); open positions are left alone |

**The switch:** on the status page, type `ON` and press *Turn real trading ON*. Off by default.

An order is only sent when all of these hold: switch on, not paused, no position open (the agent's or any
other on this market), the signal is from the bar that just closed, the daily caps are not reached, IG lists
the market as TRADEABLE, and the size and stop distance meet IG's minimums. Each order is a market order
with the stop (30) and target (90) attached, so IG holds them even if the agent is down. At 17:30 the
agent closes any open position. *Close position now* closes it immediately. Turning the switch off stops
new orders but keeps managing an open position (stop, target, 17:30) until it is closed.

The agent compares its view with IG's open positions on every run: positions closed by IG are recorded
with the stop or target level, its own position is picked up again after a restart, and any other position
on the market blocks new orders (it is never touched).

## Stage 2: deploy the agent to Cloudflare

The agent wakes 8 seconds after every 3-minute bar closes (every 15 minutes while the market is
closed), reads IG prices, runs the rules and keeps paper trades with the same exits as the backtest.
**It never sends orders.** A status page shows zones, Monday levels, bias, paper trades and a log.

### One-time setup (on your own computer)

```bash
git clone https://github.com/perell/autolevels && cd autolevels
npm install
npx wrangler login           # opens the browser to log in to Cloudflare
npm run deploy               # creates the Worker "autolevels-agent"
```

Then add the secrets. Each command asks for the value; type or paste it there — **never put them in
files, in chat or in git**:

```bash
npx wrangler secret put IG_API_KEY      # IG demo API key (My IG > Settings > API keys)
npx wrangler secret put IG_USERNAME     # IG demo username
npx wrangler secret put IG_PASSWORD     # IG demo password
npx wrangler secret put ADMIN_TOKEN     # your own long random password for the status page
```

A good `ADMIN_TOKEN`: run `openssl rand -hex 24` (or any 30+ random characters).

### Open the status page

`https://autolevels-agent.<your-subdomain>.workers.dev/?token=<ADMIN_TOKEN>` — `wrangler deploy` prints
the exact address. The first run loads ~400 hours of history (about 400 IG data points). Bookmark the link.

### Which IG account

`IG_ACCOUNT_ID` in `wrangler.toml` (now `EY9UA`, the "Auto" CFD account) is the account the agent always
uses: it switches to it right after logging in, whatever your preferred account is. The status page and
the market finder show which account the agent is on; **Log in to IG again** clears a stored session.
IG's market search only returns markets your current account can trade.

### Find the right markets (do this first)

1. On the status page click **Market finder**.
2. Search **Germany 40**. Check that the price market's epic matches `PRICE_EPIC` in `wrangler.toml`
   (default `IX.D.DAX.IFD.IP`). If not, change it, run `npm run deploy`, then **Reload history**.
3. Search **Germany 40 Barrier**. Copy the "Full details" box and send it to Claude. It contains
   market rules only, no login data. This decides how barrier orders are placed in stage 3.

### IG data points

IG allows 10,000 price points a week per account. The agent uses about 4,500 (2–3 points per run),
plus ~400 at each history reload. **Download history** (status page) gets IG bars as CSV for the
backtester; it shows the cost first.

### Chart

**Chart** on the status page, switchable between **1h and 3m** (the 3m view shows the last ~3–4 trading days,
collected as the agent runs; open positions get entry, stop and target lines): 1h candles (last ~4 weeks, stored by the agent, no extra IG data
points) with the zones the agent found (green buy / red sell boxes with their current score; dashed
outline = original size, filled part = still unfilled; blue border = traded), Monday high/low/mid lines
per week, bias changes, paper trades and real trades. Tick "filled / expired zones" to see zones that
are no longer active. After deploying, press **Reload history** once to fill the chart.

### Controls

- **Pause signals** — keeps reading prices, takes no new signals.
- **Reload history** — rebuilds zones from IG history (after changing rules or the epic).
- `npm run dev` runs the agent locally (put the secrets in a `.dev.vars` file, which git ignores).

## Stage 1: backtester

Finds the DE30 1h imbalance zones, Monday levels and bias, scores zones, and replays 3-minute bars
through the entry/exit rules. The engine in `src/core/` is plain TypeScript with a JSON state, so the
Cloudflare agent runs the exact same code (a test checks that the agent and the backtester produce
identical trades from the same prices).

## Rules implemented (from the two Claude Docs)

| Area | Rule |
| --- | --- |
| Zone (gap) | 3-candle gap on 1h (candle 1 and 3 do not overlap); all three candles the same colour, gap at the middle one (`gapNeedsThreeSameColour`) |
| Zone (order block) | body (no wicks) of a candle followed by a candle the other way (`orderBlockRun` = 1; can be raised) |
| Valid | a zone stays valid until a 1h candle CLOSES beyond it (wicks don't count) and keeps its full size (`zoneDiesOnClose`, `shrinkZones`) |
| Reach | created within the last 10 trading days (and within 300 pts, for listing) |
| Monday | high / low / mid, available once Monday has closed |
| Bias (Tue–Fri) | 1h close above Monday high = bullish, below low = bearish; back inside within 2 candles, or a wick out from inside that closes back in = opposite bias; latest event wins; resets weekly |
| Score | Monday high/low +2, Monday mid +1, bias direction +1; shown for information, minimum 0 (`minScore`): every zone is traded |
| Waiting period | a new zone can be traded only after one full 1h candle has closed after it was found (`zoneWaitHours`); touches before that are ignored |
| Entry | touch: a 3m bar touches the zone and does not close beyond it -> market at the close. Comeback: after price has been beyond the zone, a 3m close back -> entry (no time limit while the zone is valid). At most one touch and one comeback trade per zone |
| Limits | one trade per zone, one position at a time, entries 09:00–17:00 (Berlin/Oslo time), no zone width limit (`maxZoneWidth` 0) |
| Exit | touch: stop 30 pts beyond the zone; comeback: stop 10 pts beyond the furthest price outside the zone; never closer than 30 pts to entry; target 2 pts before the nearest valid opposing zone that is at least 1x the stop away (closer ones skipped), else 3x the stop; set at entry, not moved; flat at 17:30 |
| Backtest | stop+target in the same bar = stop; gaps fill at the open; 1.2 pts spread per trade |

Every number is in `src/core/config.ts` and can be changed per run with `--set`.

## Run it

```bash
npm install
npm test                                   # rule + agent tests
npm run backtest -- --entry data/DE30_3m.csv --hour data/DE30_1h.csv --out out/real
npm run backtest -- --entry data/DE30_3m.csv --set minScore=1 --set mondayNoScore=false
```

`--hour` is optional (1h bars are built from the 3m file if left out), but a longer 1h file gives
zones and Monday levels from before the 3m data starts.

## Getting price data

Without a paid TradingView plan: use **Download history** on the agent's status page (IG prices).

### From TradingView (paid plans)

1. Open DE30EUR (or IG's Germany 40 if your TradingView shows it) on a **3-minute** chart, scroll back
   as far as it loads.
2. Chart menu (arrow next to the layout name) -> **Export chart data…** -> time format *UNIX timestamp* -> export.
3. Do the same on the **1-hour** chart.
4. Put both files in `data/`.

Export needs a paid TradingView plan. Later the agent reads IG's own prices instead.

## Output (in `--out`)

- `summary.txt` — trades, win rate, points, drawdown, results by score and by trigger
- `trades.csv` — every trade with entry, stop, target, exit and reason
- `zones.csv` — every zone found, its size and how it ended
- `mondays.csv`, `bias.csv` — weekly Monday levels and every bias change
- `overlay.pine` — paste into TradingView's Pine Editor and add to the chart: draws the engine's
  zones (blue border = traded), Monday levels (orange) and trades, so you can compare with your own levels.

`data/sample_3m.csv` is **synthetic** test data (`npm run sample-data`); its results mean nothing.
