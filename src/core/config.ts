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
  /** gap zones only when all three candles go the same way (gap at the middle one) */
  gapNeedsThreeSameColour: boolean;
  /** only zones created within this many trading days */
  reachDays: number;
  /** only zones whose nearest edge is within this many points of price */
  reachPoints: number;
  /** skip zones wider than this; 0 = no limit */
  maxZoneWidth: number;
  /** order block: the last opposite candle before at least this many candles in a row one way */
  orderBlockRun: number;
  /** find order blocks at all */
  orderBlocks: boolean;
  /** a zone dies only when a 1h candle CLOSES beyond it (wicks do not count); false = any touch of the far edge */
  zoneDiesOnClose: boolean;
  /** shrink a zone to its unfilled part when price wicks into it (false = keep full size) */
  shrinkZones: boolean;
  /** touch entry: stop this many points beyond the far edge of the zone */
  touchStopBeyondZone: number;
  /** comeback entry: stop this many points beyond the furthest price reached outside the zone */
  comebackStopBeyondSweep: number;
  /** after a touch trade, allow one more trade when price comes back into the zone after going beyond it */
  reentryOnComeback: boolean;
  /** a new zone can be traded only after this many full 1h candles have closed after it was found */
  zoneWaitHours: number;
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
  /** legacy setting, no longer used (comeback entries have no time limit) */
  reclaimBars: number;
  /** only one open position at a time */
  oneAtATime: boolean;

  // Exits
  /** the stop is never closer than this many points to the entry */
  stopPoints: number;
  /** target: 'zone' = just before the nearest opposing zone; 'ratio' = rewardRisk x the stop */
  targetMode: 'zone' | 'ratio';
  /** take profit this many points before the opposing zone's near edge */
  targetBeforeZone: number;
  /** opposing zones closer than this many times the stop are skipped (the next one is used) */
  targetMinRewardRisk: number;
  /** ratio target, and the fallback when no opposing zone is far enough */
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
  gapNeedsThreeSameColour: true,
  reachDays: 10,
  reachPoints: 300,
  maxZoneWidth: 0,
  orderBlockRun: 1,
  orderBlocks: true,
  zoneWaitHours: 1,
  zoneDiesOnClose: true,
  shrinkZones: false,
  touchStopBeyondZone: 30,
  comebackStopBeyondSweep: 10,
  reentryOnComeback: true,
  minZoneWidth: 0,

  mondayProximity: 10,
  minScore: 0,
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
  targetMode: 'zone',
  targetBeforeZone: 2,
  targetMinRewardRisk: 1,
  rewardRisk: 3,

  spreadPoints: 1.2,
};

export function withConfig(overrides: Partial<Config> = {}): Config {
  return { ...defaultConfig, ...overrides };
}
