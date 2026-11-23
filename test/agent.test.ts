import { describe, expect, it } from 'vitest';
import { aggregate } from '../src/backtest/csv';
import { runBacktest } from '../src/backtest/simulate';
import { defaultConfig } from '../src/core/config';
import type { Bar } from '../src/core/types';
import { emptyData, isMarketHours, nextRun, Runner } from '../src/agent/runner';
import { IgClient, toBars } from '../src/ig/client';

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
      return new Response(JSON.stringify({ currentAccountId: 'ABC123' }), {
        status: 200,
        headers: { CST: validCst, 'X-SECURITY-TOKEN': `sec-${logins}` },
      });
    }
    if (headers.CST !== validCst) return new Response(JSON.stringify({ errorCode: 'error.security.client-token-invalid' }), { status: 401 });
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
    if (path === '/accounts') return Response.json({ accounts: [{ accountId: 'ABC123', accountName: 'CFD', accountType: 'CFD', preferred: true }] });
    if (path === '/markets') return Response.json({ markets: [{ epic: 'IX.D.DAX.IFD.IP', instrumentName: 'Germany 40', instrumentType: 'INDICES', expiry: '-', bid: 1, offer: 2, marketStatus: 'TRADEABLE' }] });
    if (path.startsWith('/markets/') && path.includes('OPN') && headers.Version === '3')
      return Response.json({ errorCode: 'Transformation failure.' }, { status: 500 });
    if (path.startsWith('/markets/')) return Response.json({ instrument: { epic: 'x', name: 'Germany 40', type: 'INDICES' }, dealingRules: { minDealSize: { unit: 'POINTS', value: 0.5 } }, snapshot: { marketStatus: 'TRADEABLE', bid: 1, offer: 2 } });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return {
    clock,
    calls,
    expire: () => (validCst = 'expired'),
    logins: () => logins,
    client: (d: ReturnType<typeof emptyData>) =>
      new IgClient({ apiKey: 'k', username: 'u', password: 'p', env: 'demo' }, d.tokens, (t) => (d.tokens = t), fetchFn),
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
    expect(r.accounts[0].accountId).toBe('ABC123');
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
});
