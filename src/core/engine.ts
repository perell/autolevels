/**
 * The strategy engine. Pure functions over a plain JSON state, so the same code runs in the
 * backtester and later in the Cloudflare agent (state stored in a Durable Object).
 *
 * Call order:
 *   - onHourClose(state, bar1h)   after every closed 1h bar  -> zones, Monday levels, bias
 *   - onEntryBar(state, bar3m)    after every closed 3m bar  -> entry / session-end signals
 * Always feed every 1h bar that closed at or before a 3m bar's open time before that 3m bar.
 */
import type { Config } from './config';
import { scoreZone } from './scoring';
import { hm, local, weekKey } from './time';
import type { Bar, EngineState, FlatSignal, Signal, Zone } from './types';

const HOUR = 3600;
const RECENT = 10;

export function createState(): EngineState {
  return {
    recent: [],
    atr: { value: null, prevClose: null, count: 0, trSum: 0 },
    hourIndex: -1,
    tradingDates: [],
    weekKey: null,
    monday: null,
    bias: 'neutral',
    lastUpBreakIdx: null,
    lastDownBreakIdx: null,
    zones: [],
    lastPrice: null,
  };
}

export interface HourEvents {
  created: Zone[];
  died: Zone[];
  expired: Zone[];
  biasChanged?: { from: string; to: string; reason: string };
  mondayCompleted?: boolean;
}

const dir = (b: Bar) => Math.sign(b.close - b.open);

/** Process one closed 1h bar. Mutates and returns state plus what happened. */
export function onHourClose(state: EngineState, bar: Bar, cfg: Config): HourEvents {
  const ev: HourEvents = { created: [], died: [], expired: [] };
  state.hourIndex += 1;
  state.lastPrice = bar.close;

  // 1. ATR (Wilder)
  const a = state.atr;
  const tr =
    a.prevClose == null
      ? bar.high - bar.low
      : Math.max(bar.high - bar.low, Math.abs(bar.high - a.prevClose), Math.abs(bar.low - a.prevClose));
  a.count += 1;
  if (a.count <= cfg.atrPeriod) {
    a.trSum += tr;
    if (a.count === cfg.atrPeriod) a.value = a.trSum / cfg.atrPeriod;
  } else {
    a.value = ((a.value as number) * (cfg.atrPeriod - 1) + tr) / cfg.atrPeriod;
  }
  a.prevClose = bar.close;

  // 2. run of same-direction candles ending here
  const prev = state.recent[state.recent.length - 1];
  const d = dir(bar);
  const run = d === 0 ? 0 : prev && dir(prev.bar) === d ? prev.run + 1 : 1;
  state.recent.push({ bar, atr: a.value, run });
  if (state.recent.length > RECENT) state.recent.shift();

  // 3. trading dates
  const lt = local(bar.time, cfg.tz);
  if (state.tradingDates[state.tradingDates.length - 1] !== lt.date) {
    state.tradingDates.push(lt.date);
    if (state.tradingDates.length > 60) state.tradingDates.shift();
  }

  // 4. Monday levels and weekly reset
  const wk = weekKey(lt.date, lt.weekday);
  if (wk !== state.weekKey) {
    state.weekKey = wk;
    state.monday = null;
    if (state.bias !== 'neutral') ev.biasChanged = { from: state.bias, to: 'neutral', reason: 'new week' };
    state.bias = 'neutral';
    state.lastUpBreakIdx = null;
    state.lastDownBreakIdx = null;
  }
  if (lt.weekday === 1) {
    const m = state.monday;
    if (!m) state.monday = { date: lt.date, high: bar.high, low: bar.low, mid: (bar.high + bar.low) / 2, complete: false };
    else {
      m.high = Math.max(m.high, bar.high);
      m.low = Math.min(m.low, bar.low);
      m.mid = (m.high + m.low) / 2;
    }
  } else if (state.monday && !state.monday.complete) {
    state.monday.complete = true;
    ev.mondayCompleted = true;
  }

  // 5. bias from Monday's range (Tuesday-Friday)
  if (state.monday?.complete && lt.weekday !== 1) updateBias(state, bar, cfg, ev);

  // 6. update existing zones with this bar: a zone dies when a 1h candle closes beyond it
  //    (or, with zoneDiesOnClose off, when price touches its far edge)
  for (const z of state.zones) {
    if (!z.alive || z.createdAt > bar.time) continue;
    if (z.side === 'buy') {
      if (cfg.zoneDiesOnClose ? bar.close < z.low : bar.low <= z.low) kill(z, bar.time + HOUR, ev);
      else if (cfg.shrinkZones && bar.low > z.low && bar.low < z.high) z.high = bar.low;
    } else {
      if (cfg.zoneDiesOnClose ? bar.close > z.high : bar.high >= z.high) kill(z, bar.time + HOUR, ev);
      else if (cfg.shrinkZones && bar.high < z.high && bar.high > z.low) z.low = bar.high;
    }
  }

  // 7. new zones: gap from the last three candles, order block before a new run
  const n = state.recent.length;
  if (n >= 3) {
    const c1 = state.recent[n - 3];
    const c2 = state.recent[n - 2];
    const c3 = state.recent[n - 1];
    const strong = (want: number) => {
      if (dir(c2.bar) !== want) return false;
      const body = Math.abs(c2.bar.close - c2.bar.open);
      const bodyOk = c2.atr != null && body >= cfg.strongBodyAtr * c2.atr;
      const runThroughC2 = dir(c3.bar) === want ? c3.run : c2.run;
      return bodyOk || runThroughC2 >= cfg.strongRunLength;
    };
    const make = (side: 'buy' | 'sell', low: number, high: number) => {
      if (high - low <= 0 || high - low < cfg.minZoneWidth) return;
      const z: Zone = {
        id: `${side}-${c2.bar.time}`,
        kind: 'gap',
        side,
        low,
        high,
        origLow: low,
        origHigh: high,
        startTime: c1.bar.time,
        createdAt: bar.time + HOUR,
        createdDate: lt.date,
        alive: true,
        traded: false,
      };
      state.zones.push(z);
      ev.created.push(z);
    };
    if (c1.bar.high < c3.bar.low && strong(1)) make('buy', c1.bar.high, c3.bar.low);
    if (c1.bar.low > c3.bar.high && strong(-1)) make('sell', c3.bar.high, c1.bar.low);
  }

  // order block: this candle completes a run of `orderBlockRun` candles one way; the candle just
  // before the run went the other way. Zone = that candle's body (no wicks).
  const last = state.recent[n - 1];
  const N = cfg.orderBlockRun;
  if (cfg.orderBlocks && last.run === N && n >= N + 1) {
    const ob = state.recent[n - 1 - N];
    const runDir = dir(last.bar);
    if (dir(ob.bar) === -runDir) {
      const low = Math.min(ob.bar.open, ob.bar.close);
      const high = Math.max(ob.bar.open, ob.bar.close);
      if (high - low > 0 && high - low >= cfg.minZoneWidth) {
        const side = runDir > 0 ? 'buy' : 'sell';
        const z: Zone = {
          id: `ob-${side}-${ob.bar.time}`,
          kind: 'block',
          side,
          low,
          high,
          origLow: low,
          origHigh: high,
          startTime: ob.bar.time,
          createdAt: bar.time + HOUR,
          createdDate: lt.date,
          alive: true,
          traded: false,
        };
        state.zones.push(z);
        ev.created.push(z);
      }
    }
  }

  // 8. prune dead zones and zones older than the reach window
  const recentDates = new Set(state.tradingDates.slice(-cfg.reachDays));
  state.zones = state.zones.filter((z) => {
    if (!z.alive) return false;
    if (!recentDates.has(z.createdDate)) {
      z.expiredAt = bar.time + HOUR;
      ev.expired.push(z);
      return false;
    }
    return true;
  });
  return ev;
}

function kill(z: Zone, at: number, ev: HourEvents) {
  z.alive = false;
  z.diedAt = at;
  ev.died.push(z);
}

function updateBias(state: EngineState, bar: Bar, cfg: Config, ev: HourEvents) {
  const m = state.monday!;
  const before = state.bias;
  let reason = '';
  const i = state.hourIndex;
  // lastUpBreakIdx / lastDownBreakIdx = the FIRST candle of the current run of closes outside the range
  if (bar.close > m.high) {
    state.bias = 'bullish';
    if (state.lastUpBreakIdx == null) state.lastUpBreakIdx = i;
    state.lastDownBreakIdx = null;
    reason = 'close above Monday high';
  } else if (bar.close < m.low) {
    state.bias = 'bearish';
    if (state.lastDownBreakIdx == null) state.lastDownBreakIdx = i;
    state.lastUpBreakIdx = null;
    reason = 'close below Monday low';
  } else {
    // a wick counts only when the candle started inside the range, poked out and closed back in
    const falseUp =
      (cfg.wickIsFalseBreak && bar.open <= m.high && bar.high > m.high) ||
      (state.lastUpBreakIdx != null && i - state.lastUpBreakIdx <= cfg.falseBreakWindow);
    const falseDown =
      (cfg.wickIsFalseBreak && bar.open >= m.low && bar.low < m.low) ||
      (state.lastDownBreakIdx != null && i - state.lastDownBreakIdx <= cfg.falseBreakWindow);
    if (falseUp && falseDown) {
      state.bias = 'neutral';
      reason = 'false breaks both ways';
    } else if (falseUp) {
      state.bias = 'bearish';
      reason = 'false break of Monday high';
    } else if (falseDown) {
      state.bias = 'bullish';
      reason = 'false break of Monday low';
    }
    // back inside the range: any run of closes outside it has ended
    state.lastUpBreakIdx = null;
    state.lastDownBreakIdx = null;
  }
  if (state.bias !== before) ev.biasChanged = { from: before, to: state.bias, reason };
}

export interface EntryContext {
  /** is a position currently open (from the backtester or IG) */
  positionOpen: boolean;
}

/** Process one closed 3m bar. Returns at most one entry signal, or a session-end flat signal. */
export function onEntryBar(
  state: EngineState,
  bar: Bar,
  ctx: EntryContext,
  cfg: Config,
): (Signal | FlatSignal)[] {
  const out: (Signal | FlatSignal)[] = [];
  const closeTime = bar.time + cfg.entryBarSeconds;
  const lo = local(bar.time, cfg.tz);
  const lc = local(closeTime, cfg.tz);
  state.lastPrice = bar.close;
  const weekday = lo.weekday <= 5;

  if (ctx.positionOpen && weekday && lc.minutes >= hm(cfg.flatTime)) {
    out.push({ kind: 'flat', time: closeTime, price: bar.close, reason: 'session-end' });
  }

  const inWindow =
    weekday && lo.minutes >= hm(cfg.entryStart) && lc.minutes <= hm(cfg.entryEnd) && lc.minutes > lo.minutes;
  const canOpen = inWindow && !(cfg.oneAtATime && ctx.positionOpen);
  const isMonday = lo.weekday === 1;

  type Cand = { z: Zone; trigger: 'touch' | 'reclaim'; score: number; parts: string[]; stop: number };
  const cands: Cand[] = [];
  const afterBar: Zone[] = [];

  for (const z of state.zones) {
    // a new zone waits `zoneWaitHours` full 1h candles before it can be traded; touches are ignored until then
    if (!z.alive || z.traded || bar.time < tradeableFrom(z, cfg)) continue;
    const buy = z.side === 'buy';
    const beyond = buy ? bar.low < z.low : bar.high > z.high;
    if (beyond) z.sweep = buy ? Math.min(z.sweep ?? Infinity, bar.low) : Math.max(z.sweep ?? -Infinity, bar.high);
    const closedBeyond = buy ? bar.close < z.low : bar.close > z.high;
    if (closedBeyond) {
      // below a buy zone (above a sell zone): wait for a close back; the zone lives until a 1h close beyond it
      z.closedBeyond = true;
      continue;
    }
    const touched = buy ? bar.low <= z.high : bar.high >= z.low;
    // comeback: price went beyond the zone (this bar or earlier) and this bar closed back
    const comeback = z.sweep != null && (beyond || z.closedBeyond === true);
    if (comeback) {
      if (!z.touchTraded || cfg.reentryOnComeback) {
        const stop = buy ? z.sweep! - cfg.comebackStopBeyondSweep : z.sweep! + cfg.comebackStopBeyondSweep;
        const c = eligible(z, 'reclaim', stop);
        if (c) cands.push(c);
      }
      afterBar.push(z); // one chance per comeback
    } else if (touched && !z.touchTraded) {
      const stop = buy ? z.low - cfg.touchStopBeyondZone : z.high + cfg.touchStopBeyondZone;
      const c = eligible(z, 'touch', stop);
      if (c) cands.push(c);
    }
  }

  function eligible(z: Zone, trigger: Cand['trigger'], stop: number): Cand | null {
    if (!canOpen) return null;
    if (cfg.maxZoneWidth > 0 && z.high - z.low > cfg.maxZoneWidth) return null;
    const s = scoreZone(z, state.monday, state.bias, cfg);
    const needScore = !(isMonday && cfg.mondayNoScore);
    if (needScore && s.score < cfg.minScore) return null;
    return { z, trigger, score: s.score, parts: s.parts, stop };
  }

  if (cands.length) {
    const mid = (z: Zone) => (z.low + z.high) / 2;
    cands.sort((x, y) => y.score - x.score || Math.abs(mid(x.z) - bar.close) - Math.abs(mid(y.z) - bar.close));
    const picks = cfg.oneAtATime ? cands.slice(0, 1) : cands;
    for (const c of picks) {
      const long = c.z.side === 'buy';
      // stop: from the rule, never closer than stopPoints; whole points (IG needs whole-point distances)
      const raw = long ? bar.close - c.stop : c.stop - bar.close;
      const risk = Math.ceil(Math.max(raw, cfg.stopPoints) - 1e-9);
      if (c.trigger === 'touch') {
        c.z.touchTraded = true;
        if (!cfg.reentryOnComeback) c.z.traded = true;
      } else c.z.traded = true;
      const t = findTarget(state, c.z, long, bar.close, risk, cfg);
      out.push({
        kind: 'open',
        side: c.z.side,
        time: closeTime,
        price: bar.close,
        stop: long ? bar.close - risk : bar.close + risk,
        target: t.target,
        targetFrom: t.from,
        zoneId: c.z.id,
        score: c.score,
        scoreParts: c.parts,
        trigger: c.trigger,
      });
    }
  }
  for (const z of afterBar) {
    z.sweep = undefined;
    z.closedBeyond = false;
  }
  return out;
}

/**
 * Take-profit level. With targetMode 'zone': a few points before the nearest valid opposing zone
 * (sell zone above a buy, buy zone below a sell) that is at least targetMinRewardRisk x the stop away;
 * closer zones are skipped. No such zone (or targetMode 'ratio'): rewardRisk x the stop.
 */
export function findTarget(state: EngineState, entryZone: Zone, long: boolean, price: number, risk: number, cfg: Config) {
  const ratio = { target: long ? price + risk * cfg.rewardRisk : price - risk * cfg.rewardRisk, from: 'ratio' };
  if (cfg.targetMode !== 'zone') return ratio;
  const minDist = risk * cfg.targetMinRewardRisk;
  let best: { target: number; from: string } | null = null;
  for (const z of state.zones) {
    if (!z.alive || z.id === entryZone.id) continue;
    if (long && z.side === 'sell') {
      const level = z.low - cfg.targetBeforeZone;
      if (level - price >= minDist && (!best || level < best.target)) best = { target: level, from: z.id };
    } else if (!long && z.side === 'buy') {
      const level = z.high + cfg.targetBeforeZone;
      if (price - level >= minDist && (!best || level > best.target)) best = { target: level, from: z.id };
    }
  }
  return best ?? ratio;
}

/** First moment (unix s) a zone can be traded. */
export function tradeableFrom(z: Zone, cfg: Config): number {
  return z.createdAt + Math.max(0, cfg.zoneWaitHours) * HOUR;
}

/** Zones worth showing right now: alive, untraded and within `reachPoints` of price. */
export function zonesInReach(state: EngineState, cfg: Config): Zone[] {
  const p = state.lastPrice;
  return state.zones.filter((z) => {
    if (!z.alive || z.traded || p == null) return false;
    const dist = p > z.high ? p - z.high : p < z.low ? z.low - p : 0;
    return dist <= cfg.reachPoints;
  });
}
