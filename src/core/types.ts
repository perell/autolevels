/** One OHLC bar. `time` is the bar's OPEN time in unix seconds (UTC). */
export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type Side = 'buy' | 'sell';
export type Bias = 'bullish' | 'bearish' | 'neutral';

/**
 * A zone on the 1h chart:
 *  - 'gap':   3-candle imbalance (candle 1 and 3 do not overlap)
 *  - 'block': order block, the body of the last opposite candle before a run of candles one way
 */
export type ZoneKind = 'gap' | 'block';

export interface Zone {
  id: string;
  /** missing on zones stored before order blocks existed = 'gap' */
  kind?: ZoneKind;
  /** buy = zone below price (support), sell = zone above price (resistance) */
  side: Side;
  /** current unfilled part */
  low: number;
  high: number;
  /** size when created */
  origLow: number;
  origHigh: number;
  /** open time of the first of the three candles */
  startTime: number;
  /** close time of the third candle: the zone exists from here on */
  createdAt: number;
  /** Berlin trading date the zone was created on (YYYY-MM-DD) */
  createdDate: string;
  alive: boolean;
  /** when price filled the zone (or closed through it without a reclaim) */
  diedAt?: number;
  /** when the zone dropped out of the reach window */
  expiredAt?: number;
  /** a position has been opened from this zone (one trade per zone) */
  traded: boolean;
  /** a 3m bar closed through the zone; waiting for a close back */
  reclaimBarsLeft?: number;
}

export interface MondayLevels {
  date: string;
  high: number;
  low: number;
  mid: number;
  /** true once Monday has closed (first 1h bar of a later day seen) */
  complete: boolean;
}

export interface Signal {
  kind: 'open';
  side: Side;
  /** close time of the 3m bar that triggered the signal */
  time: number;
  price: number;
  stop: number;
  target: number;
  zoneId: string;
  score: number;
  scoreParts: string[];
  /** 'touch' = bar touched the zone and did not close through it; 'reclaim' = closed back after closing through */
  trigger: 'touch' | 'reclaim';
}

export interface FlatSignal {
  kind: 'flat';
  time: number;
  price: number;
  reason: 'session-end';
}

/** Everything the engine remembers between calls. Plain JSON so it can live in a Durable Object. */
export interface EngineState {
  /** last few closed 1h bars with ATR and same-direction run length, oldest first */
  recent: { bar: Bar; atr: number | null; run: number }[];
  atr: { value: number | null; prevClose: number | null; count: number; trSum: number };
  hourIndex: number;
  /** distinct Berlin dates that had 1h bars, oldest first (capped) */
  tradingDates: string[];
  weekKey: string | null;
  monday: MondayLevels | null;
  bias: Bias;
  lastUpBreakIdx: number | null;
  lastDownBreakIdx: number | null;
  zones: Zone[];
  lastPrice: number | null;
}
