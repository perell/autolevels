/**
 * Position handling shared by the backtester and the signals-only agent ("paper" trades).
 * Stop and target are checked on every 3m bar after entry. Both hit in the same bar counts as
 * the stop (conservative). A gap through a level fills at the bar's open.
 */
import type { Config } from './config';
import type { Bar, Signal } from './types';

export type ExitReason = 'stop' | 'target' | 'session-end' | 'end-of-data';

export interface Trade {
  zoneId: string;
  side: Signal['side'];
  trigger: Signal['trigger'];
  score: number;
  scoreParts: string[];
  entryTime: number;
  entry: number;
  stop: number;
  target: number;
  /** opposing zone id the target came from, or 'ratio' */
  targetFrom?: string;
  exitTime: number;
  exit: number;
  exitReason: ExitReason;
  /** points after spread */
  points: number;
}

/** Check one 3m bar (after the entry bar) against the stop and target. */
export function checkExit(pos: Signal, bar: Bar, cfg: Config): { price: number; reason: ExitReason } | null {
  const long = pos.side === 'buy';
  const stopHit = long ? bar.low <= pos.stop : bar.high >= pos.stop;
  const targetHit = long ? bar.high >= pos.target : bar.low <= pos.target;
  if (stopHit) {
    const gap = long ? bar.open < pos.stop : bar.open > pos.stop;
    return { price: gap ? bar.open : pos.stop, reason: 'stop' };
  }
  if (targetHit) {
    const gap = long ? bar.open > pos.target : bar.open < pos.target;
    return { price: gap ? bar.open : pos.target, reason: 'target' };
  }
  void cfg;
  return null;
}

export function closeTrade(pos: Signal, time: number, price: number, reason: ExitReason, cfg: Config): Trade {
  const raw = pos.side === 'buy' ? price - pos.price : pos.price - price;
  return {
    zoneId: pos.zoneId,
    side: pos.side,
    trigger: pos.trigger,
    score: pos.score,
    scoreParts: pos.scoreParts,
    entryTime: pos.time,
    entry: pos.price,
    stop: pos.stop,
    target: pos.target,
    targetFrom: pos.targetFrom,
    exitTime: time,
    exit: price,
    exitReason: reason,
    points: raw - cfg.spreadPoints,
  };
}
