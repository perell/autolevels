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
const RECENT = 5;

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

  // 6. fill / kill existing zones with this bar
  for (const z of state.zones) {
    if (!z.alive || z.createdAt > bar.time || z.reclaimBarsLeft != null) continue;
    if (z.side === 'buy') {
      if (bar.low <= z.low) kill(z, bar.time + HOUR, ev);
      else if (bar.low < z.high) z.high = bar.low;
    } else {
      if (bar.high >= z.high) kill(z, bar.time + HOUR, ev);
      else if (bar.high > z.low) z.low = bar.high;
    }
  }

  // 7. new zone from the last three candles
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

  type Cand = { z: Zone; trigger: 'touch' | 'reclaim'; score: number; parts: string[] };
  const cands: Cand[] = [];

  for (const z of state.zones) {
    if (!z.alive || z.traded || z.createdAt > bar.time) continue;
    const buy = z.side === 'buy';

    if (z.reclaimBarsLeft != null) {
      const back = buy ? bar.close >= z.low : bar.close <= z.high;
      if (back) {
        const c = eligible(z, 'reclaim');
        if (c) cands.push(c);
        else kill3m(z, closeTime); // closed back but could not trade: zone is used up
      } else {
        z.reclaimBarsLeft -= 1;
        if (z.reclaimBarsLeft <= 0) kill3m(z, closeTime);
      }
      continue;
    }

    const touched = buy ? bar.low <= z.high : bar.high >= z.low;
    if (!touched) continue;
    const through = buy ? bar.close < z.low : bar.close > z.high;
    if (through) {
      z.reclaimBarsLeft = cfg.reclaimBars;
      continue;
    }
    const c = eligible(z, 'touch');
    if (c) cands.push(c);
  }

  function eligible(z: Zone, trigger: Cand['trigger']): Cand | null {
    if (!canOpen) return null;
    if (z.high - z.low > cfg.maxZoneWidth) return null;
    const s = scoreZone(z, state.monday, state.bias, cfg);
    const needScore = !(isMonday && cfg.mondayNoScore);
    if (needScore && s.score < cfg.minScore) return null;
    return { z, trigger, score: s.score, parts: s.parts };
  }

  if (cands.length) {
    const mid = (z: Zone) => (z.low + z.high) / 2;
    cands.sort((x, y) => y.score - x.score || Math.abs(mid(x.z) - bar.close) - Math.abs(mid(y.z) - bar.close));
    const picks = cfg.oneAtATime ? cands.slice(0, 1) : cands;
    for (const c of picks) {
      const long = c.z.side === 'buy';
      const risk = cfg.stopPoints;
      c.z.traded = true;
      c.z.reclaimBarsLeft = undefined;
      out.push({
        kind: 'open',
        side: c.z.side,
        time: closeTime,
        price: bar.close,
        stop: long ? bar.close - risk : bar.close + risk,
        target: long ? bar.close + risk * cfg.rewardRisk : bar.close - risk * cfg.rewardRisk,
        zoneId: c.z.id,
        score: c.score,
        scoreParts: c.parts,
        trigger: c.trigger,
      });
    }
  }
  return out;
}

function kill3m(z: Zone, at: number) {
  z.alive = false;
  z.diedAt = at;
  z.reclaimBarsLeft = undefined;
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
