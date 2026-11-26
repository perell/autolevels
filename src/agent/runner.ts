/**
 * The agent's main loop, independent of Cloudflare so it can be tested anywhere.
 * Stage 2: SIGNALS ONLY. It reads IG prices, runs the strategy engine and keeps "paper"
 * trades (same exit rules as the backtest). It never places orders.
 */
import { summarize } from '../backtest/simulate';
import { toCsv } from '../backtest/csv';
import { withConfig, type Config } from '../core/config';
import { createState, onEntryBar, onHourClose, tradeableFrom, zonesInReach } from '../core/engine';
import { checkExit, closeTrade, type Trade } from '../core/paper';
import { scoreZone } from '../core/scoring';
import { local } from '../core/time';
import type { Bar, EngineState, Signal, Zone } from '../core/types';
import type { IgAllowance, IgClient, IgTokens, Resolution } from '../ig/client';
import { Trader, type LivePosition, type LiveTrade, type TradeSettings } from './trader';

const M3 = 180;
const HOUR = 3600;
const DATA_VERSION = 1;

export interface LogEntry {
  time: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

export interface AgentData {
  version: number;
  engine: EngineState;
  initialized: boolean;
  lastHour: number | null;
  last3m: number | null;
  paper: Signal | null;
  trades: Trade[];
  signals: Signal[];
  log: LogEntry[];
  /** pause = keep reading prices, but take no new signals */
  paused: boolean;
  lastTick: number | null;
  nextTick: number | null;
  allowance: IgAllowance | null;
  tokens: IgTokens | null;
  cfg: Partial<Config>;
  /** REAL TRADING switch. Off by default; only turned on from the status page. */
  trading: boolean;
  live: LivePosition | null;
  liveTrades: LiveTrade[];
  foreign: string | null;
  account?: import('./trader').AccountSnapshot | null;
  dayStart?: { date: string; equity: number; currency: string } | null;
  // ---- chart history ----
  /** recent closed 1h bars (oldest first) */
  hourBars: Bar[];
  /** recent closed 3m bars for the chart's 3m view (oldest first) */
  m3Bars: Bar[];
  /** every zone seen in the chart window, latest state, by creation */
  zoneLog: Zone[];
  mondays: { date: string; high: number; low: number; mid: number; from: number }[];
  biasLog: { time: number; from: string; to: string; reason: string }[];
}

const CHART_HOURS = 600;
const CHART_3M = 1500;
/** 3m candles fetched on Reload history when missing: the last 3 hours */
const BACKFILL_3M = 60;

export function emptyData(): AgentData {
  return {
    version: DATA_VERSION,
    engine: createState(),
    initialized: false,
    lastHour: null,
    last3m: null,
    paper: null,
    trades: [],
    signals: [],
    log: [],
    paused: false,
    lastTick: null,
    nextTick: null,
    allowance: null,
    tokens: null,
    cfg: {},
    trading: false,
    live: null,
    liveTrades: [],
    foreign: null,
    hourBars: [],
    m3Bars: [],
    zoneLog: [],
    mondays: [],
    biasLog: [],
  };
}

export interface RunnerOptions {
  /** IG epic used for prices (the underlying Germany 40 market) */
  priceEpic: string;
  /** how many 1h bars to load at start */
  warmupHours: number;
  /** seconds after a 3m bar closes before we read it */
  delay: number;
  /** IG account the agent should be on (for display; the IG client does the switching) */
  accountId?: string;
  /** real-trading settings; without them the agent can only paper trade */
  trade?: TradeSettings;
}

export class Runner {
  cfg: Config;
  constructor(
    public data: AgentData,
    private ig: IgClient,
    private opt: RunnerOptions,
  ) {
    this.cfg = withConfig(data.cfg);
    this.trader = opt.trade ? new Trader(data, ig, opt.trade, this.cfg, (l, m, t) => this.log(l, m, t)) : null;
  }

  trader: Trader | null;

  log(level: LogEntry['level'], msg: string, now = Date.now() / 1000) {
    this.data.log.push({ time: Math.floor(now), level, msg });
    if (this.data.log.length > 300) this.data.log.splice(0, this.data.log.length - 300);
  }

  /** Turn real trading on or off. Turning off leaves an open position (with its IG stop and target) in place. */
  setTrading(on: boolean) {
    if (on && !this.trader) throw new Error('Real trading is not configured (TRADE_EPIC missing)');
    this.data.trading = on;
    this.log(on ? 'warn' : 'info', on ? 'REAL TRADING ON' : 'Real trading off (an open position keeps its stop and target at IG)');
  }

  /** Close the agent's open position now. */
  async closeNow() {
    if (!this.trader || !this.data.live) return;
    await this.trader.close('manual', Date.now() / 1000);
  }

  /** Throw away the stored IG session; the next call logs in again (and switches account). */
  relogin() {
    this.ig.resetSession();
    this.log('info', 'IG session cleared: logging in again on the next call');
  }

  /** (Re)load history and rebuild zones, Monday levels and bias. */
  async warmup(now: number) {
    const d0 = this.data;
    const keep = {
      trades: d0.trades,
      signals: d0.signals,
      log: d0.log,
      paused: d0.paused,
      tokens: d0.tokens,
      cfg: d0.cfg,
      trading: d0.trading,
      live: d0.live,
      liveTrades: d0.liveTrades,
      foreign: d0.foreign,
      account: d0.account,
      dayStart: d0.dayStart,
      m3Bars: d0.m3Bars, // not re-fetched: keep what we have
    };
    Object.assign(this.data, emptyData(), keep);
    const hours = (await this.ig.latestBars(this.opt.priceEpic, 'HOUR', this.opt.warmupHours)).filter((b) => b.time + HOUR <= now);
    if (!hours.length) throw new Error(`No 1h prices for ${this.opt.priceEpic}. Check PRICE_EPIC (use the market finder).`);
    for (const b of hours) this.onHour(b, true);
    this.syncZones();
    // the 3m view: if the last 3 hours of 3m candles are not stored, fetch them (60 data points)
    const have = new Set(this.data.m3Bars.map((b) => b.time));
    const recent = (await this.ig.latestBars(this.opt.priceEpic, 'MINUTE_3', BACKFILL_3M + 1)).filter((b) => b.time + M3 <= now);
    const fresh = recent.slice(-BACKFILL_3M).filter((b) => !have.has(b.time));
    if (fresh.length) {
      const all = [...this.data.m3Bars, ...fresh].sort((a, b) => a.time - b.time);
      this.data.m3Bars = all.slice(-CHART_3M);
    }
    const m3 = recent;
    this.data.last3m = m3.length ? m3[m3.length - 1].time : Math.floor(now / M3) * M3 - M3;
    this.data.initialized = true;
    this.data.allowance = this.ig.lastAllowance;
    this.log('info', `Warm-up: ${hours.length} 1h bars, ${this.data.engine.zones.length} zones, bias ${this.data.engine.bias}`, now);
  }

  /** One run: read new bars, update the engine, record signals. Returns when to run next (unix s). */
  async tick(now = Date.now() / 1000): Promise<number> {
    this.data.lastTick = Math.floor(now);
    try {
      if (!this.data.initialized) await this.warmup(now);
      else await this.step(now);
    } catch (e) {
      this.log('error', e instanceof Error ? e.message : String(e), now);
    }
    this.data.allowance = this.ig.lastAllowance ?? this.data.allowance;
    this.data.nextTick = nextRun(now, this.opt.delay, this.cfg.tz);
    return this.data.nextTick;
  }

  private async step(now: number) {
    const d = this.data;
    const epic = this.opt.priceEpic;

    // real trading: first make sure we agree with IG about open positions
    let reconciled = false;
    if (this.trader && (d.trading || d.live)) {
      try {
        await this.trader.reconcile(now);
        reconciled = true;
      } catch (e) {
        this.log('error', `Could not read IG positions, no new orders this run: ${e instanceof Error ? e.message : String(e)}`, now);
      }
    } else d.foreign = null;

    // new closed 3m bars
    const last3 = d.last3m ?? Math.floor(now / M3) * M3 - 2 * M3;
    const missing3 = Math.floor((now - last3) / M3);
    if (missing3 > 61) this.log('warn', `Gap of ${missing3} 3m bars; reading the last 60`, now);
    const bars3 = missing3 >= 2 ? (await this.ig.latestBars(epic, 'MINUTE_3', Math.min(missing3, 60) + 1)).filter((b) => b.time > last3 && b.time + M3 <= now) : [];

    // new closed 1h bars
    const lastClosedHour = Math.floor(now / HOUR) * HOUR - HOUR;
    let hours: Bar[] = [];
    if (d.lastHour == null || lastClosedHour > d.lastHour) {
      const n = d.lastHour == null ? 3 : Math.min((lastClosedHour - d.lastHour) / HOUR + 1, 50);
      hours = (await this.ig.latestBars(epic, 'HOUR', n)).filter((b) => (d.lastHour == null || b.time > d.lastHour) && b.time + HOUR <= now);
    }

    let h = 0;
    const feedHours = (t: number) => {
      while (h < hours.length && hours[h].time + HOUR <= t) {
        this.onHour(hours[h++], false);
      }
    };

    for (const bar of bars3) {
      feedHours(bar.time);
      const closeTime = bar.time + M3;
      if (d.paper) {
        const exit = checkExit(d.paper, bar, this.cfg);
        if (exit) this.closePaper(closeTime, exit.price, exit.reason);
      }
      this.trader?.trackBar(bar, closeTime);
      const positionOpen = d.paper != null || d.live != null || d.foreign != null;
      const out = onEntryBar(d.engine, bar, { positionOpen }, this.cfg);
      for (const s of out) {
        if (s.kind === 'flat') {
          if (d.paper) this.closePaper(s.time, s.price, 'session-end');
          if (d.live && this.trader) await this.trader.close('session-end', now);
        }
        if (s.kind === 'open' && !d.paper) {
          if (d.paused) {
            this.log('info', `Paused: skipped ${s.side} signal at ${s.price.toFixed(1)}`, closeTime);
            continue;
          }
          d.paper = s;
          d.signals.push(s);
          if (d.signals.length > 300) d.signals.splice(0, d.signals.length - 300);
          this.log('info', `SIGNAL ${s.side.toUpperCase()} ${s.trigger} at ${s.price.toFixed(1)}, stop ${s.stop.toFixed(1)}, target ${s.target.toFixed(1)}, score ${s.score}`, closeTime);
          if (this.trader && d.trading && reconciled) {
            try {
              await this.trader.open(s, now);
            } catch (e) {
              this.log('error', `Order failed: ${e instanceof Error ? e.message : String(e)}`, now);
            }
          }
        }
      }
      d.last3m = bar.time;
      d.m3Bars.push(bar);
      if (d.m3Bars.length > CHART_3M) d.m3Bars.splice(0, d.m3Bars.length - CHART_3M);
    }
    feedHours(Number.POSITIVE_INFINITY);
    this.syncZones();
    this.trader?.finishClosed(now);
    if (!bars3.length && missing3 >= 2 && isMarketHours(now, this.cfg.tz)) {
      // no new bar although one should exist: just note it (IG can be a few seconds late)
      this.log('warn', 'No new 3m bar from IG yet', now);
    }
  }

  /** Feed one closed 1h bar to the engine and keep the chart history. */
  private onHour(bar: Bar, quiet: boolean) {
    const d = this.data;
    // save zones first: the hour update drops zones that died on a 3m bar
    for (const z of d.engine.zones) this.keepZone(z);
    const ev = onHourClose(d.engine, bar, this.cfg);
    d.lastHour = bar.time;
    d.hourBars.push(bar);
    if (d.hourBars.length > CHART_HOURS) d.hourBars.splice(0, d.hourBars.length - CHART_HOURS);
    const at = bar.time + HOUR;
    for (const z of [...ev.created, ...ev.died, ...ev.expired]) this.keepZone(z);
    if (!quiet) for (const z of ev.created) this.log('info', `New ${z.side} zone ${z.low.toFixed(1)}-${z.high.toFixed(1)}`, at);
    if (ev.mondayCompleted && d.engine.monday) {
      const m = d.engine.monday;
      d.mondays.push({ date: m.date, high: m.high, low: m.low, mid: m.mid, from: bar.time });
      if (d.mondays.length > 8) d.mondays.splice(0, d.mondays.length - 8);
      if (!quiet) this.log('info', `Monday levels: high ${m.high.toFixed(1)}, low ${m.low.toFixed(1)}, mid ${m.mid.toFixed(1)}`, at);
    }
    if (ev.biasChanged) {
      d.biasLog.push({ time: at, ...ev.biasChanged });
      if (d.biasLog.length > 100) d.biasLog.splice(0, d.biasLog.length - 100);
      if (!quiet) this.log('info', `Bias ${ev.biasChanged.from} -> ${ev.biasChanged.to} (${ev.biasChanged.reason})`, at);
    }
  }

  private keepZone(z: Zone) {
    const log = this.data.zoneLog;
    const copy = { ...z };
    const i = log.findIndex((x) => x.id === z.id);
    if (i >= 0) log[i] = copy;
    else log.push(copy);
  }

  /** Copy the engine's current zones into the chart history and drop zones older than the chart. */
  private syncZones() {
    const d = this.data;
    for (const z of d.engine.zones) this.keepZone(z);
    const first = d.hourBars[0]?.time ?? 0;
    d.zoneLog = d.zoneLog.filter((z) => z.createdAt >= first);
  }

  /** Everything the chart page draws. */
  chartData() {
    const d = this.data;
    return {
      tz: this.cfg.tz,
      bars: d.hourBars,
      bars3: d.m3Bars,
      paper: d.paper,
      zones: d.zoneLog.map((z) => {
        const open = z.alive && !z.traded && !z.diedAt && !z.expiredAt;
        return {
          ...z,
          score: open ? scoreZone(z, d.engine.monday, d.engine.bias, this.cfg).score : null,
          tradeableFrom: tradeableFrom(z, this.cfg),
        };
      }),
      mondays: d.mondays,
      bias: d.biasLog,
      signals: d.signals.slice(-100),
      paperTrades: d.trades.slice(-100),
      liveTrades: d.liveTrades.slice(-100),
      live: d.live,
      lastPrice: d.engine.lastPrice,
      rules: { maxZoneWidth: this.cfg.maxZoneWidth, minScore: this.cfg.minScore },
      now: Math.floor(Date.now() / 1000),
    };
  }

  private closePaper(time: number, price: number, reason: Trade['exitReason']) {
    const t = closeTrade(this.data.paper!, time, price, reason, this.cfg);
    this.data.trades.push(t);
    if (this.data.trades.length > 500) this.data.trades.splice(0, this.data.trades.length - 500);
    this.data.paper = null;
    this.log('info', `EXIT ${reason} at ${price.toFixed(1)}: ${t.points >= 0 ? '+' : ''}${t.points.toFixed(1)} pts`, time);
  }

  /** Everything the status page shows. */
  status() {
    const d = this.data;
    const e = d.engine;
    const zones = zonesInReach(e, this.cfg).map((z) => {
      const s = scoreZone(z, e.monday, e.bias, this.cfg);
      return { ...z, score: s.score, scoreParts: s.parts, width: z.high - z.low, tradeableFrom: tradeableFrom(z, this.cfg) };
    });
    return {
      mode: (d.trading ? 'real-trading' : 'signals-only') as 'real-trading' | 'signals-only',
      trading: d.trading,
      tradingAvailable: this.trader != null,
      tradeSettings: this.opt.trade ?? null,
      live: d.live,
      liveTrades: d.liveTrades.slice(-30).reverse(),
      today: this.trader ? this.trader.today(Math.floor(Date.now() / 1000)) : null,
      money: this.trader ? this.trader.money() : null,
      foreign: d.foreign,
      paused: d.paused,
      initialized: d.initialized,
      priceEpic: this.opt.priceEpic,
      account: d.tokens?.accountId ?? null,
      wantedAccount: this.opt.accountId ?? null,
      lastPrice: e.lastPrice,
      lastTick: d.lastTick,
      nextTick: d.nextTick,
      last3m: d.last3m,
      lastHour: d.lastHour,
      allowance: d.allowance,
      monday: e.monday,
      bias: e.bias,
      zones,
      paper: d.paper,
      summary: summarize(d.trades),
      trades: d.trades.slice(-50).reverse(),
      log: d.log.slice(-80).reverse(),
      rules: this.cfg,
    };
  }

  /**
   * Market finder: search IG (all hits) and, for one chosen epic, the full market details.
   * Search results do not depend on the account; details (dealing rules) can.
   */
  async findMarkets(term: string, epic?: string) {
    const [acc, found] = await Promise.all([
      this.ig.accounts(),
      term ? this.ig.searchMarkets(term) : Promise.resolve({ markets: [] }),
    ]);
    const details = epic ? await this.ig.marketAnyVersion(epic) : null;
    return {
      accounts: acc.accounts,
      markets: found.markets,
      details: details ? { epic, ...details } : null,
      currentAccountId: this.data.tokens?.accountId ?? null,
      wantedAccountId: this.opt.accountId ?? null,
    };
  }

  /** Price history as CSV (mid prices) for the local backtester. Costs IG data points. */
  async historyCsv(resolution: Resolution, from: number, to: number): Promise<string> {
    const bars = await this.ig.barsBetween(this.opt.priceEpic, resolution, from, to);
    this.data.allowance = this.ig.lastAllowance ?? this.data.allowance;
    return toCsv(bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })));
  }
}

/** IG's Germany 40 is closed roughly Fri 22:00 - Mon 01:15 and each night 22:00 - 01:15 (CET). */
export function isMarketHours(t: number, tz: string): boolean {
  const l = local(t, tz);
  if (l.weekday >= 6) return false;
  return l.minutes >= 60 && l.minutes < 22 * 60 + 15;
}

/** Next run: 3m bar boundary + delay while the market is open; every 15 minutes while closed. */
export function nextRun(now: number, delay: number, tz: string): number {
  const next3 = Math.floor(now / M3) * M3 + M3 + delay;
  if (isMarketHours(next3, tz)) return next3;
  return Math.floor(now / 900) * 900 + 900 + delay;
}
