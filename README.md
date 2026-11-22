# autolevels — stage 1: zone engine + backtest

Finds the DE30 1h imbalance zones, Monday levels and bias, scores zones, and replays 3-minute bars
through the entry/exit rules. The engine in `src/core/` is plain TypeScript with a JSON state, so the
Cloudflare agent (stage 2) will run the exact same code.

## Rules implemented (from the two Claude Docs)

| Area | Rule |
| --- | --- |
| Zone | 3-candle gap on 1h (candle 1 and 3 do not overlap) |
| Strong move | middle candle body >= 1.5 x ATR(14), or part of 3+ candles in a row the same way |
| Unfilled | partly filled zones shrink to the unfilled part; fully filled = dead |
| Reach | created within the last 10 trading days (and within 300 pts, for listing) |
| Monday | high / low / mid, available once Monday has closed |
| Bias (Tue–Fri) | 1h close above Monday high = bullish, below low = bearish; back inside within 2 candles, or a wick out from inside that closes back in = opposite bias; latest event wins; resets weekly |
| Score | Monday high/low +2, Monday mid +1, bias direction +1; minimum 2. Mondays: no score needed |
| Entry | 3m bar touches the zone and does not close through it -> market at the close. Closes through -> entry if a close back comes within 3 bars |
| Limits | one trade per zone, one position at a time, entries 09:00–17:00 (Berlin/Oslo time), zones wider than 25 pts skipped |
| Exit | stop 30 pts from entry, target 90 pts (3:1), flat at 17:30 |
| Backtest | stop+target in the same bar = stop; gaps fill at the open; 1.2 pts spread per trade |

Every number is in `src/core/config.ts` and can be changed per run with `--set`.

## Run it

```bash
npm install
npm test                                   # 27 rule tests
npm run backtest -- --entry data/DE30_3m.csv --hour data/DE30_1h.csv --out out/real
npm run backtest -- --entry data/DE30_3m.csv --set minScore=1 --set mondayNoScore=false
```

`--hour` is optional (1h bars are built from the 3m file if left out), but a longer 1h file gives
zones and Monday levels from before the 3m data starts.

## Getting real data from TradingView

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
