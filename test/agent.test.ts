import { describe, expect, it } from 'vitest';
import { aggregate } from '../src/backtest/csv';
import { runBacktest } from '../src/backtest/simulate';
import { defaultConfig } from '../src/core/config';
import type { Bar } from '../src/core/types';
import { emptyData, isMarketHours, nextRun, Runner } from '../src/agent/runner';
import { IgClient, toBars } from '../src/ig/client';
import { local } from '../src/core/time';
import { Trader, type TradeSettings } from '../src/agent/trader';
import type { Signal } from '../src/core/types';

/** Seeded synthetic 3m bars, weekdays 00:00-21:00 UTC, with impulses so zones form. */
function syntheticBars(weeks: number, seed = 11): Bar[] {
  let s = seed;
  const rand = () => ((s = (s * 1664525 + 1013904223) % 4294967296), s / 4294967296);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const start = Date.UTC(2026, 8, 7) / 1000; // Monday
  let p = 24000;
  let imp = 0;
  let left = 0;
  const out: Bar[] = [];
  for (let t = start; t < start + weeks * 7 * 86400; t += 180) {
    const d = new Date(t * 1000);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6 || d.getUTCHours() >= 21) continue;
    if (left <= 0 && rand() < 0.004) {
      imp = (rand() < 0.5 ? -1 : 1) * (2 + rand() * 4);
      left = 10 + Math.floor(rand() * 25);
    }
    const drift = left-- > 0 ? imp : 0;
    const o = p;
    let hi = o;
    let lo = o;
    for (let i = 0; i < 6; i++) {
      p += gauss() * 2.5 + drift / 6;
      hi = Math.max(hi, p);
      lo = Math.min(lo, p);
    }
    const r = (n: number) => Math.round(n * 10) / 10;
    out.push({ time: t, open: r(o), high: r(hi), low: r(lo), close: r(p) });
  }
  return out;
}

/** A fake IG REST API serving the given bars "as of" a controllable clock. */
function fakeIg(m3: Bar[], h1: Bar[]) {
  const clock = { now: 0 };
  const calls: string[] = [];
  let validCst = 'cst-1';
  let logins = 0;
  // server-side session account: login lands on the preferred account (BAR1, barriers only)
  let sessionAccount = 'BAR1';
  let switches = 0;
  // ---- dealing ----
  type Pos = { dealId: string; dealReference: string; epic: string; direction: 'BUY' | 'SELL'; size: number; level: number; stopLevel: number; limitLevel: number; guaranteed: boolean; openedAt: number; checked: number };
  const positions: Pos[] = [];
  const confirms = new Map<string, Record<string, unknown>>();
  const orders: Record<string, unknown>[] = [];
  const closedLog: { dealId: string; reason: string; at: number; level: number }[] = [];
  const deal = { reject: '' as string, dropAnswer: false, nextId: 1, maxOpen: 0, balance: 1000, profitLoss: 0 };
  const lastClosed = () => [...m3].reverse().find((b) => b.time + 180 <= clock.now);
  const closePos = (p: Pos, level: number, reason: string, at: number) => {
    positions.splice(positions.indexOf(p), 1);
    closedLog.push({ dealId: p.dealId, reason, at, level });
  };
  // IG holds stops and limits: close positions whose stop/limit was touched by bars since the last check
  const runStops = () => {
    for (const p of [...positions]) {
      for (const b of m3) {
        if (b.time < p.checked || b.time + 180 > clock.now) continue;
        p.checked = b.time + 180;
        const long = p.direction === 'BUY';
        if (long ? b.low <= p.stopLevel : b.high >= p.stopLevel) {
          closePos(p, p.stopLevel, 'stop', b.time + 180);
          break;
        }
        if (long ? b.high >= p.limitLevel : b.low <= p.limitLevel) {
          closePos(p, p.limitLevel, 'limit', b.time + 180);
          break;
        }
      }
    }
  };
  const row = (b: Bar) => {
    const side = (v: number) => ({ bid: v - 0.6, ask: v + 0.6, lastTraded: null });
    return {
      snapshotTime: 'ignored',
      snapshotTimeUTC: new Date(b.time * 1000).toISOString().slice(0, 19),
      openPrice: side(b.open),
      highPrice: side(b.high),
      lowPrice: side(b.low),
      closePrice: side(b.close),
    };
  };
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/gateway/deal', '');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push(`${init?.method ?? 'GET'} ${path}${url.search}`);
    if (path === '/session' && init?.method === 'POST') {
      logins++;
      validCst = `cst-${logins}`;
      sessionAccount = 'BAR1';
      return new Response(JSON.stringify({ currentAccountId: 'BAR1' }), {
        status: 200,
        headers: { CST: validCst, 'X-SECURITY-TOKEN': `sec-${logins}` },
      });
    }
    if (headers.CST !== validCst) return new Response(JSON.stringify({ errorCode: 'error.security.client-token-invalid' }), { status: 401 });
    runStops();
    if (path === '/positions') {
      return Response.json({
        positions: positions.map((p) => ({
          position: { dealId: p.dealId, dealReference: p.dealReference, direction: p.direction, size: p.size, level: p.level, stopLevel: p.stopLevel, limitLevel: p.limitLevel, controlledRisk: p.guaranteed, createdDateUTC: new Date(p.openedAt * 1000).toISOString().slice(0, 19) },
          market: { epic: p.epic },
        })),
      });
    }
    if (path === '/positions/otc' && init?.method === 'POST' && headers._method === 'DELETE') {
      const b = JSON.parse(String(init.body));
      const p = positions.find((x) => x.dealId === b.dealId);
      const ref = `CLOSE${deal.nextId++}`;
      if (!p) confirms.set(ref, { dealStatus: 'REJECTED', reason: 'POSITION_NOT_FOUND' });
      else {
        const bar = lastClosed()!;
        const level = p.direction === 'BUY' ? bar.close - 0.6 : bar.close + 0.6;
        closePos(p, level, 'closed-by-agent', clock.now);
        confirms.set(ref, { dealStatus: 'ACCEPTED', reason: 'SUCCESS', dealId: p.dealId, level });
      }
      return Response.json({ dealReference: ref });
    }
    if (path === '/positions/otc' && init?.method === 'POST') {
      const b = JSON.parse(String(init.body));
      orders.push(b);
      if (deal.reject) {
        confirms.set(b.dealReference, { dealStatus: 'REJECTED', reason: deal.reject });
      } else {
        const bar = lastClosed()!;
        const level = b.direction === 'BUY' ? bar.close + 0.6 : bar.close - 0.6;
        const sign = b.direction === 'BUY' ? 1 : -1;
        const p: Pos = {
          dealId: `D${deal.nextId++}`, dealReference: b.dealReference, epic: b.epic, direction: b.direction, size: b.size, level,
          stopLevel: level - sign * b.stopDistance, limitLevel: level + sign * b.limitDistance, guaranteed: b.guaranteedStop, openedAt: clock.now, checked: clock.now,
        };
        positions.push(p);
        deal.maxOpen = Math.max(deal.maxOpen, positions.length);
        confirms.set(b.dealReference, { dealStatus: 'ACCEPTED', reason: 'SUCCESS', dealId: p.dealId, level, stopLevel: p.stopLevel, limitLevel: p.limitLevel });
      }
      if (deal.dropAnswer) throw new TypeError('network connection lost');
      return Response.json({ dealReference: b.dealReference });
    }
    if (path.startsWith('/confirms/')) {
      const c = confirms.get(decodeURIComponent(path.slice('/confirms/'.length)));
      return c ? Response.json(c) : Response.json({ errorCode: 'error.confirms.deal-not-found' }, { status: 404 });
    }
    if (path.startsWith('/prices/')) {
      const res = url.searchParams.get('resolution');
      const max = Number(url.searchParams.get('max'));
      const src = res === 'HOUR' ? h1 : m3;
      const avail = src.filter((b) => b.time <= clock.now); // includes the bar still forming
      return Response.json({
        prices: avail.slice(-max).map(row),
        metadata: { allowance: { remainingAllowance: 9000, totalAllowance: 10000, allowanceExpiry: 1000 } },
      });
    }
    if (path === '/session' && init?.method === 'PUT') {
      const want = JSON.parse(String(init.body)).accountId;
      if (want === sessionAccount) return Response.json({ errorCode: 'error.switch.accountId-must-be-different' }, { status: 412 });
      sessionAccount = want;
      switches++;
      return Response.json({ dealingEnabled: true });
    }
    if (path === '/accounts')
      return Response.json({
        accounts: [
          { accountId: 'BAR1', accountName: 'Barriers', accountType: 'CFD', preferred: true, currency: 'NOK', balance: { balance: 50, deposit: 0, profitLoss: 0, available: 50 } },
          { accountId: 'CFD1', accountName: 'Auto', accountType: 'CFD', preferred: false, currency: 'NOK', balance: { balance: deal.balance, deposit: 0, profitLoss: deal.profitLoss, available: deal.balance } },
        ],
      });
    if (path === '/markets') {
      const barrier = { epic: 'IX.D.DAX.OPNCALL.IP', instrumentName: 'Germany 40 Barrier Long', instrumentType: 'KNOCKOUTS_INDICES', expiry: 'FEB-27', bid: 1, offer: 2, marketStatus: 'TRADEABLE' };
      const cash = { epic: 'IX.D.DAX.IFD.IP', instrumentName: 'Germany 40', instrumentType: 'INDICES', expiry: '-', bid: 1, offer: 2, marketStatus: 'TRADEABLE' };
      return Response.json({ markets: sessionAccount === 'BAR1' ? [barrier] : [cash, barrier] });
    }
    if (path.startsWith('/markets/') && path.includes('OPN') && headers.Version === '3')
      return Response.json({ errorCode: 'Transformation failure.' }, { status: 500 });
    if (path.startsWith('/markets/'))
      return Response.json({
        instrument: { epic: 'x', name: 'Germany 40', type: 'INDICES', currencies: [{ code: 'EUR', isDefault: false }] },
        dealingRules: { minDealSize: { unit: 'POINTS', value: 0.5 }, minControlledRiskStopDistance: { unit: 'POINTS', value: 25 }, minNormalStopOrLimitDistance: { unit: 'POINTS', value: 8 } },
        snapshot: { marketStatus: 'TRADEABLE', bid: 1, offer: 2 },
      });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return {
    clock,
    calls,
    positions,
    orders,
    closedLog,
    deal,
    expire: () => (validCst = 'expired'),
    logins: () => logins,
    switches: () => switches,
    sessionAccount: () => sessionAccount,
    client: (d: ReturnType<typeof emptyData>, accountId = 'CFD1') =>
      new IgClient({ apiKey: 'k', username: 'u', password: 'p', env: 'demo', accountId }, d.tokens, (t) => (d.tokens = t), fetchFn),
  };
}

const opts = { priceEpic: 'IX.D.DAX.IFD.IP', warmupHours: 400, delay: 8 };

describe('IG price parsing', () => {
  it('turns bid/ask rows into mid-price bars on UTC time', () => {
    const [b] = toBars([
      {
        snapshotTime: '2026/11/20 10:00:00',
        snapshotTimeUTC: '2026-11-20T09:00:00',
        openPrice: { bid: 100, ask: 102, lastTraded: null },
        highPrice: { bid: 110, ask: 112, lastTraded: null },
        lowPrice: { bid: 90, ask: 92, lastTraded: null },
        closePrice: { bid: 105, ask: 107, lastTraded: null },
      },
    ]);
    expect(b).toEqual({ time: Date.UTC(2026, 10, 20, 9) / 1000, open: 101, high: 111, low: 91, close: 106 });
  });
});

describe('agent schedule', () => {
  it('runs 8 s after each 3m close while open, every 15 min while closed', () => {
    const tue10 = Date.UTC(2026, 10, 17, 9, 1, 30) / 1000; // 10:01:30 Berlin
    expect(nextRun(tue10, 8, 'Europe/Berlin')).toBe(Date.UTC(2026, 10, 17, 9, 3, 8) / 1000);
    const sat = Date.UTC(2026, 10, 21, 12, 1) / 1000;
    expect(isMarketHours(sat, 'Europe/Berlin')).toBe(false);
    expect(nextRun(sat, 8, 'Europe/Berlin')).toBe(Date.UTC(2026, 10, 21, 12, 15, 8) / 1000);
  });
});

describe('agent against a fake IG', () => {
  const m3 = syntheticBars(10);
  const h1 = aggregate(m3, 3600);

  it('produces exactly the same paper trades as the backtester', async () => {
    const ig = fakeIg(m3, h1);
    const data = emptyData();
    // start after 3 weeks of history
    let now = Date.UTC(2026, 8, 28, 6, 0, 8) / 1000;
    ig.clock.now = now;
    const runner = new Runner(data, ig.client(data), opts);
    now = await runner.tick(now);
    expect(data.initialized).toBe(true);
    const startAfter = data.last3m!;

    const end = m3[m3.length - 1].time + 600;
    let ticks = 0;
    while (now < end) {
      ig.clock.now = now;
      // persist/restore like the Durable Object does between alarms
      const restored = JSON.parse(JSON.stringify(data));
      const r = new Runner(restored, ig.client(restored), opts);
      now = await r.tick(now);
      Object.assign(data, restored);
      ticks++;
    }
    expect(data.log.filter((l) => l.level === 'error')).toEqual([]);

    const bt = runBacktest(h1, m3.filter((b) => b.time > startAfter), defaultConfig);
    const closed = bt.trades.filter((t) => t.exitReason !== 'end-of-data');
    expect(closed.length).toBeGreaterThanOrEqual(5);
    expect(data.trades).toEqual(closed);
    console.log(`agent = backtest: ${closed.length} trades over ${ticks} ticks`);
    expect(ticks).toBeGreaterThan(1000);
  });

  it('keeps chart history that matches the backtester (bars, zones, Monday levels)', async () => {
    const ig = fakeIg(m3, h1);
    let data = emptyData();
    let now = Date.UTC(2026, 8, 28, 6, 0, 8) / 1000;
    ig.clock.now = now;
    now = await new Runner(data, ig.client(data), opts).tick(now);
    const startAfter = data.last3m!;
    const end = Date.UTC(2026, 9, 16) / 1000;
    while (now < end) {
      ig.clock.now = now;
      data = JSON.parse(JSON.stringify(data));
      now = await new Runner(data, ig.client(data), opts).tick(now);
    }
    const chart = new Runner(data, ig.client(data), opts).chartData();
    const last = data.lastTick!; // 'now' is already the next scheduled run
    const closedHours = h1.filter((b) => b.time + 3600 <= last);
    expect(chart.bars).toEqual(closedHours.slice(-600));
    const bt = runBacktest(closedHours, m3.filter((b) => b.time > startAfter && b.time + 180 <= last), defaultConfig);
    const first = chart.bars[0].time;
    const btZones = bt.zones.filter((z) => z.createdAt >= first);
    expect(chart.zones.map((z) => z.id).sort()).toEqual(btZones.map((z) => z.id).sort());
    // a zone's end state matches (filled / expired / still open)
    for (const z of chart.zones) {
      const b = btZones.find((x) => x.id === z.id)!;
      expect([z.alive, z.diedAt ?? null, z.low, z.high]).toEqual([b.alive, b.diedAt ?? null, b.low, b.high]);
    }
    expect(chart.mondays.map((m) => [m.date, m.high, m.low])).toEqual(bt.mondays.slice(-8).map((m) => [m.date, m.high, m.low]));
    expect(chart.zones.some((z) => z.score != null)).toBe(true);
  });

  it('logs in again when the session token expires', async () => {
    const ig = fakeIg(m3, h1);
    const data = emptyData();
    const now = Date.UTC(2026, 8, 28, 9, 0, 8) / 1000;
    ig.clock.now = now;
    await new Runner(data, ig.client(data), opts).tick(now);
    expect(ig.logins()).toBe(1);
    ig.expire();
    ig.clock.now = now + 180;
    await new Runner(data, ig.client(data), opts).tick(now + 180);
    expect(ig.logins()).toBe(2);
    expect(data.log.filter((l) => l.level === 'error')).toEqual([]);
  });

  it('while paused it keeps reading prices but takes no signals', async () => {
    const ig = fakeIg(m3, h1);
    const data = emptyData();
    let now = Date.UTC(2026, 8, 28, 6, 0, 8) / 1000;
    ig.clock.now = now;
    now = await new Runner(data, ig.client(data), opts).tick(now);
    data.paused = true;
    const end = Date.UTC(2026, 9, 10) / 1000;
    while (now < end) {
      ig.clock.now = now;
      now = await new Runner(data, ig.client(data), opts).tick(now);
    }
    expect(data.trades).toHaveLength(0);
    expect(data.last3m).toBeGreaterThan(Date.UTC(2026, 9, 9) / 1000);
    expect(data.log.some((l) => l.msg.startsWith('Paused: skipped'))).toBe(true);
  });

  it('uses only a few IG data points per tick', async () => {
    const ig = fakeIg(m3, h1);
    const data = emptyData();
    let now = Date.UTC(2026, 8, 28, 6, 0, 8) / 1000;
    ig.clock.now = now;
    now = await new Runner(data, ig.client(data), opts).tick(now);
    ig.calls.length = 0;
    for (let i = 0; i < 40; i++) {
      ig.clock.now = now;
      now = await new Runner(data, ig.client(data), opts).tick(now);
    }
    const maxes = ig.calls.filter((c) => c.includes('/prices/')).map((c) => Number(new URL(`http://x${c.split(' ')[1]}`).searchParams.get('max')));
    expect(Math.max(...maxes)).toBeLessThanOrEqual(3);
  });

  it('market finder lists all hits and shows details for one epic', async () => {
    const ig = fakeIg(m3, h1);
    const data = emptyData();
    const r = await new Runner(data, ig.client(data), opts).findMarkets('Germany 40', 'IX.D.DAX.IFD.IP');
    expect(r.accounts.map((a) => a.accountId)).toEqual(['BAR1', 'CFD1']);
    expect(r.currentAccountId).toBe('CFD1');
    expect(r.markets[0].epic).toBe('IX.D.DAX.IFD.IP');
    expect(r.details).toMatchObject({ version: 3, data: { dealingRules: { minDealSize: { value: 0.5 } } }, errors: [] });
  });

  it('falls back to older API versions when version 3 fails', async () => {
    const ig = fakeIg(m3, h1);
    const data = emptyData();
    const r = await new Runner(data, ig.client(data), opts).findMarkets('', 'IX.D.DAX.OPNCALL.IP');
    expect(r.details?.version).toBe(2);
    expect(r.details?.errors[0]).toMatchObject({ version: 3 });
    expect(r.markets).toEqual([]);
  });

  it('switches to IG_ACCOUNT_ID right after login, and only once', async () => {
    const ig = fakeIg(m3, h1);
    const data = emptyData();
    let now = Date.UTC(2026, 8, 28, 9, 0, 8) / 1000;
    ig.clock.now = now;
    now = await new Runner(data, ig.client(data), opts).tick(now);
    expect(ig.sessionAccount()).toBe('CFD1');
    expect(data.tokens?.accountId).toBe('CFD1');
    for (let i = 0; i < 5; i++) {
      ig.clock.now = now;
      now = await new Runner(data, ig.client(data), opts).tick(now);
    }
    expect(ig.switches()).toBe(1);
    expect(ig.logins()).toBe(1);
  });

  it('moves a stored session from the wrong account to IG_ACCOUNT_ID', async () => {
    const ig = fakeIg(m3, h1);
    const data = emptyData();
    // first run without an account setting: stays on the preferred (barriers) account
    const r0 = await new Runner(data, ig.client(data, ''), opts).findMarkets('Germany 40');
    expect(r0.currentAccountId).toBe('BAR1');
    expect(r0.markets.map((m) => m.epic)).toEqual(['IX.D.DAX.OPNCALL.IP']);
    // with IG_ACCOUNT_ID set, the same stored session is switched over, no new login
    const r1 = await new Runner(data, ig.client(data), opts).findMarkets('Germany 40');
    expect(r1.currentAccountId).toBe('CFD1');
    expect(r1.markets[0].epic).toBe('IX.D.DAX.IFD.IP');
    expect(ig.logins()).toBe(1);
  });

  it('logs in again when the stored session has expired before a switch', async () => {
    const ig = fakeIg(m3, h1);
    const data = emptyData();
    await new Runner(data, ig.client(data, ''), opts).findMarkets('x'); // session on BAR1
    ig.expire();
    const r = await new Runner(data, ig.client(data), opts).findMarkets('Germany 40');
    expect(r.currentAccountId).toBe('CFD1');
    expect(ig.logins()).toBe(2);
  });

  it('"Log in to IG again" clears the session', async () => {
    const ig = fakeIg(m3, h1);
    const data = emptyData();
    const runner = new Runner(data, ig.client(data), opts);
    await runner.findMarkets('x');
    runner.relogin();
    expect(data.tokens).toBeNull();
    await runner.findMarkets('x');
    expect(ig.logins()).toBe(2);
    expect(data.tokens?.accountId).toBe('CFD1');
  });
});

describe('real trading against a fake IG that executes orders', () => {
  const m3 = syntheticBars(10);
  const h1 = aggregate(m3, 3600);
  const trade: TradeSettings = { epic: 'IX.D.DAX.IFD.IP', size: 0.5, guaranteedStop: true, maxTradesPerDay: 3, maxDailyLossPoints: 100, maxDailyLossPercent: 5 };

  /** Run the agent tick by tick, saving/restoring state between ticks like the Durable Object. */
  async function run(o: { trading?: boolean; trade?: Partial<TradeSettings>; until?: number; setup?: (ig: ReturnType<typeof fakeIg>) => void } = {}) {
    const ig = fakeIg(m3, h1);
    o.setup?.(ig);
    let data = emptyData();
    const topts = { ...opts, trade: { ...trade, ...o.trade } };
    let now = Date.UTC(2026, 8, 28, 6, 0, 8) / 1000;
    ig.clock.now = now;
    now = await new Runner(data, ig.client(data), topts).tick(now);
    if (o.trading) data.trading = true;
    const end = o.until ?? m3[m3.length - 1].time + 600;
    while (now < end) {
      ig.clock.now = now;
      data = JSON.parse(JSON.stringify(data));
      const r = new Runner(data, ig.client(data), topts);
      (r.trader as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
      now = await r.tick(now);
    }
    return { ig, data };
  }

  it('sends no orders while the switch is off (the default)', async () => {
    const { ig, data } = await run();
    expect(data.trading).toBe(false);
    expect(data.trades.length).toBeGreaterThan(3); // paper trades happened
    expect(ig.orders).toEqual([]);
  });

  it('with the switch on: correct orders, one position at a time, caps and 17:30 close respected', async () => {
    const { ig, data } = await run({ trading: true });
    expect(ig.orders.length).toBeGreaterThan(3);
    for (const o of ig.orders) {
      expect(o).toMatchObject({ epic: 'IX.D.DAX.IFD.IP', expiry: '-', size: 0.5, orderType: 'MARKET', currencyCode: 'EUR', forceOpen: true, guaranteedStop: true });
      expect(Number(o.stopDistance)).toBeGreaterThanOrEqual(30);
      expect(Number(o.limitDistance)).toBe(3 * Number(o.stopDistance));
      expect(String(o.dealReference)).toMatch(/^ALV[a-z0-9]{1,27}$/);
    }
    expect(ig.deal.maxOpen).toBe(1);
    // every position the agent opened is closed, and the agent agrees with IG
    expect(ig.positions).toHaveLength(0);
    expect(data.live).toBeNull();
    expect(data.liveTrades).toHaveLength(ig.orders.length);
    // nothing left open after 17:30, and no more than 3 orders a day
    for (const c of ig.closedLog) {
      const l = local(c.at, 'Europe/Berlin');
      expect(l.minutes).toBeLessThanOrEqual(17 * 60 + 33);
    }
    const perDay = new Map<string, number>();
    for (const t of data.liveTrades) {
      const day = local(t.openedAt, 'Europe/Berlin').date;
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
    }
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(3);
    // every exit matches what IG did (reason and level), none unknown
    for (const t of data.liveTrades) {
      const c = ig.closedLog.find((x) => x.dealId === t.dealId)!;
      expect(t.exit).toBeCloseTo(c.level, 6);
      expect({ stop: 'stop', limit: 'target', 'closed-by-agent': 'session-end' }[c.reason]).toBe(t.reason);
    }
    expect(data.liveTrades.filter((t) => t.reason === 'stop').length).toBeGreaterThan(0);
    expect(data.liveTrades.filter((t) => t.reason === 'target').length).toBeGreaterThan(0);
    // stop/target exits recorded at the IG levels: a stop loses the stop distance, a target wins 3x
    for (const t of data.liveTrades.filter((x) => x.reason === 'stop' || x.reason === 'target')) {
      expect(Math.abs(t.points!)).toBeCloseTo(t.reason === 'stop' ? t.risk! : 3 * t.risk!, 5);
    }
    expect(data.log.filter((l) => l.level === 'error')).toEqual([]);
  });

  it('respects a lower daily trade limit', async () => {
    const { data } = await run({ trading: true, trade: { maxTradesPerDay: 1 } });
    const days = data.liveTrades.map((t) => local(t.openedAt, 'Europe/Berlin').date);
    expect(new Set(days).size).toBe(days.length);
  });

  it('refuses a size below IG minimum', async () => {
    const { ig, data } = await run({ trading: true, trade: { size: 0.01 }, until: Date.UTC(2026, 9, 9) / 1000 });
    expect(ig.orders).toEqual([]);
    expect(data.log.some((l) => l.msg.includes('below IG') && l.msg.includes('minimum'))).toBe(true);
  });

  it('a rejected order opens nothing and is not retried', async () => {
    const { ig, data } = await run({ trading: true, until: Date.UTC(2026, 9, 9) / 1000, setup: (f) => (f.deal.reject = 'INSUFFICIENT_FUNDS') });
    expect(ig.orders.length).toBeGreaterThan(0);
    expect(new Set(ig.orders.map((o) => o.dealReference)).size).toBe(ig.orders.length);
    expect(data.live).toBeNull();
    expect(data.log.some((l) => l.msg.includes('INSUFFICIENT_FUNDS'))).toBe(true);
  });

  it('a lost answer from IG is recovered through the deal confirmation', async () => {
    const { ig, data } = await run({ trading: true, until: Date.UTC(2026, 9, 9) / 1000, setup: (f) => (f.deal.dropAnswer = true) });
    expect(ig.orders.length).toBeGreaterThan(0);
    expect(data.liveTrades.length + (data.live ? 1 : 0)).toBe(ig.orders.length);
    expect(ig.deal.maxOpen).toBe(1);
  });

  it('another open position on the market blocks new orders', async () => {
    const { ig, data } = await run({
      trading: true,
      until: Date.UTC(2026, 9, 9) / 1000,
      setup: (f) =>
        f.positions.push({ dealId: 'MANUAL1', dealReference: 'MYOWNTRADE', epic: 'IX.D.DAX.IFD.IP', direction: 'BUY', size: 1, level: 1, stopLevel: -1e9, limitLevel: 1e9, guaranteed: false, openedAt: 0, checked: 1e12 }),
    });
    expect(ig.orders).toEqual([]);
    expect(data.foreign).toContain('1 other open position');
    expect(ig.positions.map((p) => p.dealId)).toEqual(['MANUAL1']); // never touched
  });

  it("takes over the agent's own position after losing its state", async () => {
    const ig = fakeIg(m3, h1);
    const data = emptyData();
    const now = Date.UTC(2026, 8, 29, 9, 0, 8) / 1000;
    ig.clock.now = now;
    ig.positions.push({ dealId: 'D77', dealReference: 'ALVxyz', epic: 'IX.D.DAX.IFD.IP', direction: 'SELL', size: 0.5, level: 24000, stopLevel: 1e9, limitLevel: -1e9, guaranteed: true, openedAt: now - 600, checked: 1e12 });
    const r = new Runner(data, ig.client(data), { ...opts, trade });
    await r.tick(now); // warm-up
    data.trading = true;
    ig.clock.now = now + 180;
    await new Runner(data, ig.client(data), { ...opts, trade }).tick(now + 180);
    expect(data.live).toMatchObject({ dealId: 'D77', side: 'sell', entry: 24000 });
  });

  it('turning the switch off keeps managing an open position until it closes', async () => {
    const ig = fakeIg(m3, h1);
    let data = emptyData();
    const topts = { ...opts, trade };
    let now = Date.UTC(2026, 8, 28, 6, 0, 8) / 1000;
    ig.clock.now = now;
    now = await new Runner(data, ig.client(data), topts).tick(now);
    data.trading = true;
    const end = m3[m3.length - 1].time;
    while (now < end && !data.live) {
      ig.clock.now = now;
      const r = new Runner(data, ig.client(data), topts);
      (r.trader as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
      now = await r.tick(now);
    }
    expect(data.live).not.toBeNull();
    const ordersSoFar = ig.orders.length;
    new Runner(data, ig.client(data), topts).setTrading(false);
    const stopAt = now + 3 * 86400;
    while (now < stopAt) {
      ig.clock.now = now;
      data = JSON.parse(JSON.stringify(data));
      now = await new Runner(data, ig.client(data), topts).tick(now);
    }
    expect(data.live).toBeNull(); // closed by stop/target or at 17:30
    expect(ig.positions).toHaveLength(0);
    expect(ig.orders.length).toBe(ordersSoFar); // no new orders
  });
});

describe('order safety checks', () => {
  const m3 = syntheticBars(4);
  const h1 = aggregate(m3, 3600);
  const trade: TradeSettings = { epic: 'IX.D.DAX.IFD.IP', size: 0.5, guaranteedStop: true, maxTradesPerDay: 3, maxDailyLossPoints: 100, maxDailyLossPercent: 5 };
  const now = Date.UTC(2026, 8, 29, 10, 0, 8) / 1000; // Tue 12:00 Berlin
  const sig = (over: Partial<Signal> = {}): Signal => ({
    kind: 'open', side: 'buy', time: now - 8, price: 24000, stop: 23970, target: 24090, zoneId: 'z', score: 2, scoreParts: [], trigger: 'touch', ...over,
  });
  function setup(over: Partial<TradeSettings> = {}, cfgOver = {}) {
    const ig = fakeIg(m3, h1);
    ig.clock.now = now;
    const data = emptyData();
    data.trading = true;
    const logs: string[] = [];
    const cfg = { ...defaultConfig, ...cfgOver };
    // balance already read today (the 5% rule has its own tests)
    data.account = { accountId: 'CFD1', currency: 'NOK', balance: 1000, profitLoss: 0, available: 1000, at: now };
    data.dayStart = { date: '2026-09-29', equity: 1000, currency: 'NOK' };
    const t = new Trader(data, ig.client(data), { ...trade, ...over }, cfg, (_l, m) => logs.push(m), async () => {});
    return { ig, data, t, logs };
  }
  const lost = (openedAt: number, points: number | null) => ({
    dealId: 'X', side: 'buy' as const, size: 0.5, zoneId: 'z', openedAt, entry: 1, closedAt: openedAt + 60, exit: null, reason: 'stop' as const, points, estimated: true,
  });

  it('opens when every check passes', async () => {
    const { t, data, ig } = setup();
    expect(await t.open(sig(), now)).toBe(true);
    expect(data.live?.dealId).toBeTruthy();
    expect(ig.orders).toHaveLength(1);
  });

  it('does nothing while the switch is off', async () => {
    const { t, data, ig } = setup();
    data.trading = false;
    expect(await t.open(sig(), now)).toBe(false);
    expect(ig.orders).toHaveLength(0);
  });

  it('stops after the daily loss limit (unknown results count as a full loss)', async () => {
    const a = setup();
    a.data.liveTrades.push(lost(now - 3600, -30), lost(now - 1800, -30), );
    expect(await a.t.open(sig(), now)).toBe(true); // -60 so far: still allowed
    const b = setup({ maxTradesPerDay: 10 });
    b.data.liveTrades.push(lost(now - 3600, -30), lost(now - 2400, -30), lost(now - 1800, -40));
    expect(await b.t.open(sig(), now)).toBe(false);
    expect(b.logs.join()).toContain('daily loss limit');
    const c = setup({ maxTradesPerDay: 10 });
    c.data.liveTrades.push(lost(now - 3600, null), lost(now - 2400, null), lost(now - 1800, null), lost(now - 1200, null));
    expect(await c.t.open(sig(), now)).toBe(false); // 4 x -32
    expect(c.ig.orders).toHaveLength(0);
  });

  it("yesterday's losses do not count today", async () => {
    const { t, data } = setup();
    data.liveTrades.push(lost(now - 86400, -30), lost(now - 86400 + 60, -30), lost(now - 86400 + 120, -60));
    expect(await t.open(sig(), now)).toBe(true);
  });

  it('stops after the daily trade limit', async () => {
    const { t, data, logs } = setup();
    data.liveTrades.push(lost(now - 3600, 90), lost(now - 2400, 90), lost(now - 1800, 90));
    expect(await t.open(sig(), now)).toBe(false);
    expect(logs.join()).toContain('daily limit of 3 trades');
  });

  it('ignores a stale signal', async () => {
    const { t, ig, logs } = setup();
    expect(await t.open(sig({ time: now - 15 * 60 }), now)).toBe(false);
    expect(ig.orders).toHaveLength(0);
    expect(logs.join()).toContain('min old');
  });

  it('refuses a stop closer than IG allows for guaranteed stops', async () => {
    const { t, ig, logs } = setup();
    expect(await t.open(sig({ stop: 23980, target: 24060 }), now)).toBe(false); // 20 points

    expect(ig.orders).toHaveLength(0);
    expect(logs.join()).toContain('closer than IG allows');
  });

  it('never opens a second position', async () => {
    const { t, ig } = setup();
    expect(await t.open(sig(), now)).toBe(true);
    expect(await t.open(sig({ zoneId: 'other' }), now)).toBe(false);
    expect(ig.orders).toHaveLength(1);
  });
});

describe('daily loss limit in % of the account', () => {
  const m3 = syntheticBars(4);
  const h1 = aggregate(m3, 3600);
  const trade: TradeSettings = { epic: 'IX.D.DAX.IFD.IP', size: 0.5, guaranteedStop: true, maxTradesPerDay: 99, maxDailyLossPoints: 1e9, maxDailyLossPercent: 5 };
  const now = Date.UTC(2026, 8, 29, 10, 0, 8) / 1000; // Tue 12:00 Berlin
  const sig = (): Signal => ({ kind: 'open', side: 'buy', time: now - 8, price: 24000, stop: 23960, target: 24120, zoneId: 'z', score: 0, scoreParts: [], trigger: 'touch' });
  function setup() {
    const ig = fakeIg(m3, h1);
    ig.clock.now = now;
    const data = emptyData();
    data.trading = true;
    const logs: string[] = [];
    const t = new Trader(data, ig.client(data), trade, defaultConfig, (_l, m) => logs.push(m), async () => {});
    return { ig, data, t, logs };
  }

  it('reads the balance of the account the agent is on and sets the start of the day', async () => {
    const { t, data, ig } = setup();
    ig.deal.balance = 1000;
    await t.reconcile(now);
    expect(data.account).toMatchObject({ accountId: 'CFD1', currency: 'NOK', balance: 1000 });
    expect(data.dayStart).toMatchObject({ date: '2026-09-29', equity: 1000 });
    ig.deal.balance = 990;
    await t.reconcile(now + 600);
    expect(data.dayStart?.equity).toBe(1000); // unchanged during the day
    expect(t.money()).toMatchObject({ change: -10, pct: -1, limit: 50, left: 40 });
  });

  it('no new positions after a 5% loss (open P&L counts), open position untouched', async () => {
    const { t, data, ig, logs } = setup();
    ig.deal.balance = 1000;
    await t.reconcile(now);
    ig.deal.balance = 970;
    ig.deal.profitLoss = -25; // -5.5% including the open loss
    await t.reconcile(now + 600);
    expect(await t.open({ ...sig(), time: now + 592 }, now + 600)).toBe(false);
    expect(logs.join()).toContain('daily loss limit of 5% reached');
    expect(ig.orders).toHaveLength(0);
    // a 4.9% loss is still allowed
    ig.deal.profitLoss = -19;
    await t.reconcile(now + 900);
    expect(await t.open({ ...sig(), time: now + 892 }, now + 900)).toBe(true);
    void data;
  });

  it('a new day starts from the new balance', async () => {
    const { t, data, ig } = setup();
    ig.deal.balance = 1000;
    await t.reconcile(now);
    ig.deal.balance = 900; // -10% today
    await t.reconcile(now + 600);
    expect(await t.open({ ...sig(), time: now + 592 }, now + 600)).toBe(false);
    const tomorrow = now + 86400;
    ig.clock.now = tomorrow;
    await t.reconcile(tomorrow);
    expect(data.dayStart).toMatchObject({ date: '2026-09-30', equity: 900 });
    expect(await t.open({ ...sig(), time: tomorrow - 8 }, tomorrow)).toBe(true);
  });

  it('without a balance it opens nothing', async () => {
    const { t, logs } = setup();
    expect(await t.open(sig(), now)).toBe(false);
    expect(logs.join()).toContain('account balance unknown');
  });
});
