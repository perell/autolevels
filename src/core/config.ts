/**
 * All tunable rules in one place. Values follow the rules agreed in
 * "DE30 Agent: Bias, Scoring and Open Rules" and the DE30 1h Zone Strategy doc.
 */
export interface Config {
  /** local time zone for sessions, Mondays and trading days */
  tz: string;

  // Zones
  atrPeriod: number;
  /** strong move: middle candle body >= this x ATR ... */
  strongBodyAtr: number;
  /** ... or it is part of this many candles in a row in the same direction */
  strongRunLength: number;
  /** only zones created within this many trading days */
  reachDays: number;
  /** only zones whose nearest edge is within this many points of price */
  reachPoints: number;
  /** skip zones wider than this (stop is fixed from entry) */
  maxZoneWidth: number;
  /** ignore tiny gaps narrower than this */
  minZoneWidth: number;

  // Monday levels, bias, score
  /** a zone is "at" a Monday level when the level is inside it or this close */
  mondayProximity: number;
  minScore: number;
  /** on Mondays (no Monday levels or bias yet) zones need no score */
  mondayNoScore: boolean;
  /** a close back inside the Monday range within this many 1h candles = false break */
  falseBreakWindow: number;
  /** a wick beyond the Monday high/low that closes back inside counts as a false break */
  wickIsFalseBreak: boolean;

  // Entries (3m)
  /** length of the entry bars in seconds (3-minute bars) */
  entryBarSeconds: number;
  /** no new positions before / after these local times (HH:MM) */
  entryStart: string;
  entryEnd: string;
  /** close any open position at this local time */
  flatTime: string;
  /** after a 3m close through the zone, a close back within this many bars is an entry */
  reclaimBars: number;
  /** only one open position at a time */
  oneAtATime: boolean;

  // Exits
  stopPoints: number;
  rewardRisk: number;

  // Backtest only
  /** cost per round trip in points (spread) */
  spreadPoints: number;
}

export const defaultConfig: Config = {
  tz: 'Europe/Berlin',

  atrPeriod: 14,
  strongBodyAtr: 1.5,
  strongRunLength: 3,
  reachDays: 10,
  reachPoints: 300,
  maxZoneWidth: 25,
  minZoneWidth: 0,

  mondayProximity: 10,
  minScore: 2,
  mondayNoScore: true,
  falseBreakWindow: 2,
  wickIsFalseBreak: true,

  entryBarSeconds: 180,
  entryStart: '09:00',
  entryEnd: '17:00',
  flatTime: '17:30',
  reclaimBars: 3,
  oneAtATime: true,

  stopPoints: 30,
  rewardRisk: 3,

  spreadPoints: 1.2,
};

export function withConfig(overrides: Partial<Config> = {}): Config {
  return { ...defaultConfig, ...overrides };
}
