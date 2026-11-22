/**
 * Backtest: replays 1h and 3m bars through the engine and simulates fills.
 * Exits: stop and target are checked on every 3m bar after entry (both hit in the same bar
 * counts as the stop, to stay conservative; a gap through a level fills at the bar's open);
 * any open position is closed at the session-end flat time.
 */
import type { Config } from '../core/config';
import { createState, onEntryBar, onHourClose } from '../core/engine';
import { checkExit, closeTrade, type ExitReason, type Trade } from '../core/paper';
import type { Bar, Bias, Signal, Zone } from '../core/types';

export type { Trade } from '../core/paper';

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
  let pos: Signal | null = null;
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

  const close = (time: number, price: number, reason: ExitReason) => {
    trades.push(closeTrade(pos!, time, price, reason, cfg));
    pos = null;
  };

  for (const bar of entryBars) {
    feedHoursUntil(bar.time);
    const closeTime = bar.time + cfg.entryBarSeconds;

    // manage an open position with this bar (stop/target are held by the broker)
    if (pos) {
      const exit = checkExit(pos, bar, cfg);
      if (exit) close(closeTime, exit.price, exit.reason);
    }

    const signals = onEntryBar(state, bar, { positionOpen: pos != null }, cfg);
    for (const s of signals) {
      if (s.kind === 'flat' && pos) close(s.time, s.price, 'session-end');
      if (s.kind === 'open' && !pos) pos = s;
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
