import { describe, expect, it } from 'vitest';
import { withConfig } from '../src/core/config';
import { createState, onEntryBar, onHourClose } from '../src/core/engine';
import { scoreZone } from '../src/core/scoring';
import type { Bar, EngineState, Zone } from '../src/core/types';
import { runBacktest } from '../src/backtest/simulate';

const cfg = withConfig();
// November 2026: Berlin = UTC+1. Monday 16 Nov 2026 00:00 UTC
const MON = Date.UTC(2026, 10, 16, 0, 0) / 1000;
const TUE = MON + 86400;
const H = 3600;
const bar = (time: number, open: number, high: number, low: number, close: number): Bar => ({ time, open, high, low, close });

function zone(p: Partial<Zone> = {}): Zone {
  return {
    id: 'buy-test',
    side: 'buy',
    low: 100,
    high: 120,
    origLow: 100,
    origHigh: 120,
    startTime: MON,
    createdAt: MON + 3 * H,
    createdDate: '2026-11-16',
    alive: true,
    traded: false,
    ...p,
  };
}

/** state with one zone, Monday levels done and a bias; for entry tests */
function entryState(z: Zone, bias: EngineState['bias'] = 'bullish'): EngineState {
  const s = createState();
  s.zones = [z];
  s.monday = { date: '2026-11-16', high: 300, low: 105, mid: 202.5, complete: true };
  s.bias = bias;
  return s;
}
// Tuesday 10:00 Berlin = 09:00 UTC
const T10 = TUE + 9 * H;

describe('zones on the 1h chart', () => {
  it('finds a buy zone after three strong up candles', () => {
    const s = createState();
    onHourClose(s, bar(MON, 100, 112, 99, 110), cfg);
    onHourClose(s, bar(MON + H, 110, 131, 109, 130), cfg);
    const ev = onHourClose(s, bar(MON + 2 * H, 130, 141, 120, 140), cfg);
    expect(ev.created).toHaveLength(1);
    expect(ev.created[0]).toMatchObject({ side: 'buy', low: 112, high: 120, createdAt: MON + 3 * H });
  });

  it('finds a sell zone after three strong down candles', () => {
    const s = createState();
    onHourClose(s, bar(MON, 200, 201, 188, 190), cfg);
    onHourClose(s, bar(MON + H, 190, 191, 169, 170), cfg);
    const ev = onHourClose(s, bar(MON + 2 * H, 170, 180, 159, 160), cfg);
    expect(ev.created[0]).toMatchObject({ side: 'sell', low: 180, high: 188 });
  });

  it('ignores a gap that did not come from a strong move', () => {
    const s = createState();
    onHourClose(s, bar(MON, 110, 112, 99, 100), cfg); // down
    onHourClose(s, bar(MON + H, 100, 125, 99, 104), cfg); // small up body, no ATR yet
    const ev = onHourClose(s, bar(MON + 2 * H, 130, 141, 120, 125), cfg); // down
    expect(ev.created.filter((z) => z.kind === 'gap')).toHaveLength(0);
  });

  it('accepts a big-body middle candle even without a run of 3', () => {
    const s = createState();
    // build ATR: 14 quiet bars of range 10
    for (let i = 0; i < 14; i++) onHourClose(s, bar(MON + i * H, 100, 105, 95, i % 2 ? 101 : 99), cfg);
    const t = MON + 14 * H;
    onHourClose(s, bar(t, 101, 104, 96, 97), cfg); // down
    onHourClose(s, bar(t + H, 97, 130, 96, 128), cfg); // body 31 >= 1.5 x ATR (~10-12)
    const ev = onHourClose(s, bar(t + 2 * H, 128, 135, 110, 127), cfg); // down candle, gap 104 -> 110
    expect(ev.created[0]).toMatchObject({ side: 'buy', low: 104, high: 110 });
  });

  it('order block: body of a down candle followed by an up candle = buy zone (no wicks)', () => {
    const s = createState();
    onHourClose(s, bar(MON, 101, 102, 99, 100.5), cfg); // down
    onHourClose(s, bar(MON + H, 100.5, 102, 80, 90), cfg); // DOWN: body 90-100.5, wick to 80
    const ev = onHourClose(s, bar(MON + 2 * H, 90, 96, 89, 95), cfg); // up -> order block
    const ob = ev.created.find((z) => z.kind === 'block');
    expect(ob).toMatchObject({ side: 'buy', low: 90, high: 100.5, startTime: MON + H, createdAt: MON + 3 * H });
    // a second up candle does not make it again
    const ev2 = onHourClose(s, bar(MON + 3 * H, 95, 99, 94, 98), cfg);
    expect(ev2.created.filter((z) => z.kind === 'block')).toHaveLength(0);
  });

  it('order block: body of an up candle followed by a down candle = sell zone', () => {
    const s = createState();
    onHourClose(s, bar(MON + H, 199.5, 230, 199, 210), cfg); // UP: body 199.5-210, wick to 230
    const ev = onHourClose(s, bar(MON + 2 * H, 210, 211, 203, 204), cfg); // down
    expect(ev.created.find((z) => z.kind === 'block')).toMatchObject({ side: 'sell', low: 199.5, high: 210 });
  });

  it('no order block when the candle before goes the same way or is flat', () => {
    const s = createState();
    onHourClose(s, bar(MON, 100, 106, 99, 105), cfg); // up
    const same = onHourClose(s, bar(MON + H, 105, 108, 104, 107), cfg); // up again
    expect(same.created.filter((z) => z.kind === 'block')).toHaveLength(0);
    onHourClose(s, bar(MON + 2 * H, 107, 108, 106, 107), cfg); // flat (doji)
    const afterDoji = onHourClose(s, bar(MON + 3 * H, 107, 109, 106, 108.5), cfg); // up after a doji
    expect(afterDoji.created.filter((z) => z.kind === 'block')).toHaveLength(0);
  });

  it('the number of candles is a setting (e.g. 2)', () => {
    const s = createState();
    const two = withConfig({ orderBlockRun: 2 });
    onHourClose(s, bar(MON + H, 100.5, 102, 80, 90), two); // down
    const one = onHourClose(s, bar(MON + 2 * H, 90, 96, 89, 95), two); // up 1
    expect(one.created.filter((z) => z.kind === 'block')).toHaveLength(0);
    const ev = onHourClose(s, bar(MON + 3 * H, 95, 99, 94, 98), two); // up 2
    expect(ev.created.find((z) => z.kind === 'block')).toMatchObject({ side: 'buy', low: 90, high: 100.5 });
  });

  it('order blocks can be switched off', () => {
    const s = createState();
    const off = withConfig({ orderBlocks: false });
    onHourClose(s, bar(MON + H, 100.5, 102, 80, 90), off);
    onHourClose(s, bar(MON + 2 * H, 90, 96, 89, 95), off);
    const ev = onHourClose(s, bar(MON + 3 * H, 95, 99, 94, 98), off);
    expect(ev.created.filter((z) => z.kind === 'block')).toHaveLength(0);
  });

  it('shrinks a partly filled zone and kills a filled one', () => {
    const s = createState();
    const z = zone();
    s.zones = [z];
    onHourClose(s, bar(MON + 3 * H, 130, 135, 115, 125), cfg);
    expect(z.high).toBe(115);
    expect(z.alive).toBe(true);
    const ev = onHourClose(s, bar(MON + 4 * H, 125, 126, 99, 110), cfg);
    expect(z.alive).toBe(false);
    expect(ev.died).toContain(z);
    expect(s.zones).toHaveLength(0);
  });

  it('drops zones older than 10 trading days', () => {
    const s = createState();
    s.zones = [zone({ createdDate: '2026-11-02' })];
    for (let d = 0; d < 11; d++) {
      // one bar per weekday from 3 Nov, far above the zone
      const day = Date.UTC(2026, 10, 3 + d) / 1000 + 10 * H;
      onHourClose(s, bar(day, 500, 501, 499, 500), cfg);
    }
    expect(s.zones).toHaveLength(0);
  });
});

describe('Monday levels and bias', () => {
  function withMonday() {
    const s = createState();
    onHourClose(s, bar(MON + 8 * H, 100, 150, 90, 120), cfg);
    onHourClose(s, bar(MON + 9 * H, 120, 160, 100, 130), cfg);
    return s; // Monday high 160, low 90, mid 125
  }

  it('records Monday high, low and mid once Monday is over', () => {
    const s = withMonday();
    expect(s.monday?.complete).toBe(false);
    const ev = onHourClose(s, bar(TUE, 130, 140, 120, 135), cfg);
    expect(ev.mondayCompleted).toBe(true);
    expect(s.monday).toMatchObject({ high: 160, low: 90, mid: 125, complete: true });
    expect(s.bias).toBe('neutral');
  });

  it('close above Monday high = bullish, close below low = bearish', () => {
    const s = withMonday();
    onHourClose(s, bar(TUE, 150, 170, 150, 165), cfg);
    expect(s.bias).toBe('bullish');
    for (let i = 1; i <= 3; i++) onHourClose(s, bar(TUE + i * H, 165, 168, 162, 166), cfg);
    onHourClose(s, bar(TUE + 4 * H, 100, 100, 80, 85), cfg);
    expect(s.bias).toBe('bearish');
  });

  it('closing back inside within 2 candles is a false break -> opposite bias', () => {
    const s = withMonday();
    onHourClose(s, bar(TUE, 150, 170, 150, 165), cfg); // break up
    onHourClose(s, bar(TUE + H, 165, 167, 162, 163), cfg); // still above
    onHourClose(s, bar(TUE + 2 * H, 163, 164, 150, 155), cfg); // back inside, 2 candles later
    expect(s.bias).toBe('bearish');
  });

  it('closing back inside after the window keeps the breakout bias', () => {
    const s = withMonday();
    for (let i = 0; i < 4; i++) onHourClose(s, bar(TUE + i * H, 162, 170, 161, 165), cfg);
    onHourClose(s, bar(TUE + 4 * H, 165, 165, 150, 155), cfg); // 4 candles after the first close above
    expect(s.bias).toBe('bullish');
  });

  it('a wick below Monday low that closes inside = false break down -> bullish', () => {
    const s = withMonday();
    onHourClose(s, bar(TUE, 100, 105, 80, 100), cfg);
    expect(s.bias).toBe('bullish');
  });

  it('resets levels and bias at the start of a new week', () => {
    const s = withMonday();
    onHourClose(s, bar(TUE, 150, 170, 150, 165), cfg);
    expect(s.bias).toBe('bullish');
    const nextMon = MON + 7 * 86400;
    onHourClose(s, bar(nextMon + 8 * H, 165, 166, 164, 165), cfg);
    expect(s.bias).toBe('neutral');
    expect(s.monday).toMatchObject({ date: '2026-11-23', complete: false });
  });
});

describe('confluence score', () => {
  const m = { date: '2026-11-16', high: 200, low: 100, mid: 150, complete: true };
  it('+2 at Monday high/low, +1 at mid, +1 with bias', () => {
    expect(scoreZone(zone({ low: 95, high: 110 }), m, 'bullish', cfg).score).toBe(3);
    expect(scoreZone(zone({ low: 145, high: 155 }), m, 'bullish', cfg).score).toBe(2); // mid + bias
    expect(scoreZone(zone({ low: 95, high: 110 }), { ...m, complete: false }, 'neutral', cfg).score).toBe(0); // Monday not done
  });
  it('proximity is 10 points', () => {
    expect(scoreZone(zone({ low: 109, high: 118 }), m, 'neutral', cfg).score).toBe(2);
    expect(scoreZone(zone({ low: 111, high: 118 }), m, 'neutral', cfg).score).toBe(0);
    expect(scoreZone(zone({ low: 140, high: 145 }), m, 'neutral', cfg).score).toBe(1);
    expect(scoreZone(zone({ side: 'sell', low: 140, high: 145 }), m, 'bearish', cfg).score).toBe(2);
  });
});

describe('3-minute entries', () => {
  it('touch + close inside or out of the zone = entry at the close, stop 30, target 90', () => {
    const s = entryState(zone()); // Monday low 105 sits in the zone -> score 2 (+1 bullish) = 3
    const [sig] = onEntryBar(s, bar(T10, 125, 126, 118, 121), { positionOpen: false }, cfg);
    expect(sig).toMatchObject({ kind: 'open', side: 'buy', price: 121, stop: 91, target: 211, trigger: 'touch', score: 3 });
    expect(s.zones[0].traded).toBe(true);
  });

  it('one trade per zone', () => {
    const s = entryState(zone());
    onEntryBar(s, bar(T10, 125, 126, 118, 121), { positionOpen: false }, cfg);
    expect(onEntryBar(s, bar(T10 + 180, 121, 122, 115, 119), { positionOpen: false }, cfg)).toHaveLength(0);
  });

  it('close through the zone = no entry; close back within 3 bars = entry', () => {
    const s = entryState(zone());
    expect(onEntryBar(s, bar(T10, 125, 126, 95, 97), { positionOpen: false }, cfg)).toHaveLength(0);
    expect(onEntryBar(s, bar(T10 + 180, 97, 99, 92, 96), { positionOpen: false }, cfg)).toHaveLength(0);
    const [sig] = onEntryBar(s, bar(T10 + 360, 96, 104, 95, 103), { positionOpen: false }, cfg);
    expect(sig).toMatchObject({ kind: 'open', trigger: 'reclaim', price: 103 });
  });

  it('no close back within 3 bars = zone dead', () => {
    const s = entryState(zone());
    onEntryBar(s, bar(T10, 125, 126, 95, 97), { positionOpen: false }, cfg);
    for (let i = 1; i <= 3; i++) onEntryBar(s, bar(T10 + i * 180, 97, 99, 92, 96), { positionOpen: false }, cfg);
    expect(s.zones[0].alive).toBe(false);
    expect(onEntryBar(s, bar(T10 + 4 * 180, 96, 110, 95, 108), { positionOpen: false }, cfg)).toHaveLength(0);
  });

  it('no new positions outside 09:00-17:00 or while a position is open', () => {
    const early = entryState(zone());
    expect(onEntryBar(early, bar(TUE + 7 * H + 57 * 60, 125, 126, 118, 121), { positionOpen: false }, cfg)).toHaveLength(0); // 08:57-09:00
    const late = entryState(zone());
    expect(onEntryBar(late, bar(TUE + 16 * H, 125, 126, 118, 121), { positionOpen: false }, cfg)).toHaveLength(0); // 17:00
    const busy = entryState(zone());
    expect(onEntryBar(busy, bar(T10, 125, 126, 118, 121), { positionOpen: true }, cfg)).toHaveLength(0);
    const last = entryState(zone());
    expect(onEntryBar(last, bar(TUE + 15 * H + 57 * 60, 125, 126, 118, 121), { positionOpen: false }, cfg)).toHaveLength(1); // 16:57-17:00
  });

  it('trades wide zones (no width limit) and zones with score 0 (the default)', () => {
    const wide = entryState(zone({ low: 60, high: 120 })); // 60 points wide
    expect(onEntryBar(wide, bar(T10, 125, 126, 118, 121), { positionOpen: false }, cfg)).toHaveLength(1);
    const weak = entryState(zone({ low: 130, high: 140 }), 'neutral'); // far from Monday levels, no bias
    const [sig] = onEntryBar(weak, bar(T10, 145, 146, 138, 141), { positionOpen: false }, cfg);
    expect(sig).toMatchObject({ kind: 'open', score: 0 });
  });

  it('a minimum score can still be set (Tue-Fri)', () => {
    const weak = entryState(zone({ low: 130, high: 140 }), 'neutral');
    expect(onEntryBar(weak, bar(T10, 145, 146, 138, 141), { positionOpen: false }, withConfig({ minScore: 2 }))).toHaveLength(0);
  });

  it('a width limit can still be set', () => {
    const wide = entryState(zone({ low: 60, high: 120 }));
    expect(onEntryBar(wide, bar(T10, 125, 126, 118, 121), { positionOpen: false }, withConfig({ maxZoneWidth: 25 }))).toHaveLength(0);
  });

  it('on Mondays the zone alone is enough', () => {
    const s = createState();
    s.zones = [zone({ low: 130, high: 140 })];
    const mon10 = MON + 9 * H;
    expect(onEntryBar(s, bar(mon10, 145, 146, 138, 141), { positionOpen: false }, cfg)).toHaveLength(1);
  });

  it('sell zones mirror buy zones', () => {
    const s = entryState(zone({ id: 'sell-x', side: 'sell', low: 290, high: 310 }), 'bearish');
    const [sig] = onEntryBar(s, bar(T10, 280, 295, 279, 293), { positionOpen: false }, cfg);
    expect(sig).toMatchObject({ side: 'sell', price: 293, stop: 323, target: 203, score: 3 });
  });

  it('asks to close an open position at 17:30', () => {
    const s = entryState(zone());
    const out = onEntryBar(s, bar(TUE + 16 * H + 27 * 60, 150, 151, 149, 150), { positionOpen: true }, cfg);
    expect(out).toEqual([{ kind: 'flat', time: TUE + 16 * H + 30 * 60, price: 150, reason: 'session-end' }]);
  });
});

describe('backtest exits', () => {
  // Monday: three strong up candles make a buy zone 112-120 (created 03:00 UTC); Monday = no score needed
  const hours = [bar(MON, 100, 112, 99, 110), bar(MON + H, 110, 131, 109, 130), bar(MON + 2 * H, 130, 141, 120, 140)];
  const E = MON + 8 * H; // 09:00 Berlin
  const entry = bar(E, 125, 126, 118, 121); // long at 121, stop 91, target 211

  it('target hit', () => {
    const r = runBacktest(hours, [entry, bar(E + 180, 121, 212, 120, 200)], cfg);
    expect(r.trades[0]).toMatchObject({ exitReason: 'target', exit: 211 });
    expect(r.trades[0].points).toBeCloseTo(90 - cfg.spreadPoints);
  });

  it('stop and target in the same bar counts as the stop', () => {
    const r = runBacktest(hours, [entry, bar(E + 180, 121, 215, 85, 150)], cfg);
    expect(r.trades[0]).toMatchObject({ exitReason: 'stop', exit: 91 });
  });

  it('gap through the stop fills at the open', () => {
    const r = runBacktest(hours, [entry, bar(E + 180, 80, 85, 75, 82)], cfg);
    expect(r.trades[0]).toMatchObject({ exitReason: 'stop', exit: 80 });
  });

  it('closes at 17:30', () => {
    const quiet = [] as Bar[];
    for (let t = E + 180; t < MON + 17 * H; t += 180) quiet.push(bar(t, 130, 131, 129, 130));
    const r = runBacktest(hours, [entry, ...quiet], cfg);
    expect(r.trades[0]).toMatchObject({ exitReason: 'session-end', exitTime: MON + 16 * H + 30 * 60, exit: 130 });
  });
});
