/**
 * Backtest: replays 1h and 3m bars through the engine and simulates fills.
 * Exits: stop and target are checked on every 3m bar after entry (both hit in the same bar
 * counts as the stop, to stay conservative; a gap through a level fills at the bar's open);
 * any open position is closed at the session-end flat time.
 */
import type { Config } from '../core/config';
import { createState, onEntryBar, onHourClose } from '../core/engine';
import type { Bar, Bias, Side, Signal, Zone } from '../core/types';

export interface Trade {
  zoneId: string;
  side: Side;
  trigger: Signal['trigger'];
  score: number;
  scoreParts: string[];
  entryTime: number;
  entry: number;
  stop: number;
  target: number;
  exitTime: number;
  exit: number;
  exitReason: 'stop' | 'target' | 'session-end' | 'end-of-data';
  /** points after spread */
  points: number;
}

export interface MondayRecord {
  date: string;
  high: number;
  low: number;
  mid: number;
}

export interface BiasRecord {
  time: number;
  from: string;
  to: Bias | string;
  reason: string;
}

export interface BacktestResult {
  trades: Trade[];
  zones: Zone[];
  mondays: MondayRecord[];
  biasChanges: BiasRecord[];
  firstEntryBar: number | null;
  lastEntryBar: number | null;
}

const HOUR = 3600;

export function runBacktest(hourBars: Bar[], entryBars: Bar[], cfg: Config): BacktestResult {
  const state = createState();
  const allZones: Zone[] = [];
  const mondays: MondayRecord[] = [];
  const biasChanges: BiasRecord[] = [];
  const trades: Trade[] = [];
  let pos: (Signal & { open: true }) | null = null;
  let h = 0;

  const feedHoursUntil = (t: number) => {
    while (h < hourBars.length && hourBars[h].time + HOUR <= t) {
      const bar = hourBars[h++];
      const ev = onHourClose(state, bar, cfg);
      allZones.push(...ev.created);
      if (ev.mondayCompleted && state.monday) {
        const { date, high, low, mid } = state.monday;
        mondays.push({ date, high, low, mid });
      }
      if (ev.biasChanged) biasChanges.push({ time: bar.time + HOUR, ...ev.biasChanged });
    }
  };

  const close = (time: number, price: number, reason: Trade['exitReason']) => {
    const p = pos!;
    const raw = p.side === 'buy' ? price - p.price : p.price - price;
    trades.push({
      zoneId: p.zoneId,
      side: p.side,
      trigger: p.trigger,
      score: p.score,
      scoreParts: p.scoreParts,
      entryTime: p.time,
      entry: p.price,
      stop: p.stop,
      target: p.target,
      exitTime: time,
      exit: price,
      exitReason: reason,
      points: raw - cfg.spreadPoints,
    });
    pos = null;
  };

  for (const bar of entryBars) {
    feedHoursUntil(bar.time);
    const closeTime = bar.time + cfg.entryBarSeconds;

    // manage an open position with this bar (stop/target are held by the broker)
    if (pos) {
      const long = pos.side === 'buy';
      const stopHit = long ? bar.low <= pos.stop : bar.high >= pos.stop;
      const targetHit = long ? bar.high >= pos.target : bar.low <= pos.target;
      if (stopHit) {
        const gap = long ? bar.open < pos.stop : bar.open > pos.stop;
        close(closeTime, gap ? bar.open : pos.stop, 'stop');
      } else if (targetHit) {
        const gap = long ? bar.open > pos.target : bar.open < pos.target;
        close(closeTime, gap ? bar.open : pos.target, 'target');
      }
    }

    const signals = onEntryBar(state, bar, { positionOpen: pos != null }, cfg);
    for (const s of signals) {
      if (s.kind === 'flat' && pos) close(s.time, s.price, 'session-end');
      if (s.kind === 'open' && !pos) pos = { ...s, open: true };
    }
  }
  if (pos && entryBars.length) {
    const last = entryBars[entryBars.length - 1];
    close(last.time + cfg.entryBarSeconds, last.close, 'end-of-data');
  }
  // the remaining 1h bars still create zones (useful for the overlay)
  feedHoursUntil(Number.POSITIVE_INFINITY);

  return {
    trades,
    zones: allZones,
    mondays,
    biasChanges,
    firstEntryBar: entryBars[0]?.time ?? null,
    lastEntryBar: entryBars[entryBars.length - 1]?.time ?? null,
  };
}

export interface Summary {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPoints: number;
  avgPoints: number;
  maxDrawdown: number;
  byExit: Record<string, number>;
  byScore: Record<string, { trades: number; points: number }>;
  byTrigger: Record<string, { trades: number; points: number }>;
}

export function summarize(trades: Trade[]): Summary {
  let eq = 0;
  let peak = 0;
  let dd = 0;
  const byExit: Record<string, number> = {};
  const byScore: Summary['byScore'] = {};
  const byTrigger: Summary['byTrigger'] = {};
  for (const t of trades) {
    eq += t.points;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
    byExit[t.exitReason] = (byExit[t.exitReason] ?? 0) + 1;
    const s = (byScore[t.score] ??= { trades: 0, points: 0 });
    s.trades++;
    s.points += t.points;
    const g = (byTrigger[t.trigger] ??= { trades: 0, points: 0 });
    g.trades++;
    g.points += t.points;
  }
  const wins = trades.filter((t) => t.points > 0).length;
  return {
    trades: trades.length,
    wins,
    losses: trades.length - wins,
    winRate: trades.length ? wins / trades.length : 0,
    totalPoints: eq,
    avgPoints: trades.length ? eq / trades.length : 0,
    maxDrawdown: dd,
    byExit,
    byScore,
    byTrigger,
  };
}
