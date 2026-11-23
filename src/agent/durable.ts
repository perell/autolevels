/// <reference types="@cloudflare/workers-types" />
/**
 * The agent lives in one Durable Object. Its alarm wakes it a few seconds after every 3m bar
 * closes (every 15 minutes while the market is closed). State is kept in Durable Object storage.
 */
import { IgClient, type IgCredentials, type Resolution } from '../ig/client';
import { chartPage } from './chart';
import { historyPage, marketsPage, statusPage } from './page';
import { emptyData, Runner, type AgentData } from './runner';
import type { TradeSettings } from './trader';

export interface Env {
  AGENT: DurableObjectNamespace;
  IG_API_KEY: string;
  IG_USERNAME: string;
  IG_PASSWORD: string;
  IG_ENV: string;
  PRICE_EPIC: string;
  /** IG account the agent must use, e.g. EY9UA (empty = preferred account) */
  IG_ACCOUNT_ID?: string;
  /** real trading: market, size, guaranteed stop, daily caps (all in wrangler.toml) */
  TRADE_EPIC?: string;
  TRADE_SIZE?: string;
  GUARANTEED_STOP?: string;
  MAX_TRADES_PER_DAY?: string;
  MAX_DAILY_LOSS_POINTS?: string;
  ADMIN_TOKEN: string;
}

// stored under separate keys to stay well inside per-value size limits
const KEYS = ['core', 'trades', 'signals', 'log', 'bars', 'zones'] as const;

export class AgentDO {
  constructor(
    private ctx: DurableObjectState,
    private env: Env,
  ) {}

  private async load(): Promise<AgentData> {
    const got = await this.ctx.storage.get<unknown>([...KEYS]);
    const core = got.get('core') as Partial<AgentData> | undefined;
    if (!core) return emptyData();
    return {
      ...emptyData(),
      ...core,
      trades: (got.get('trades') as AgentData['trades']) ?? [],
      signals: (got.get('signals') as AgentData['signals']) ?? [],
      log: (got.get('log') as AgentData['log']) ?? [],
      hourBars: (got.get('bars') as AgentData['hourBars']) ?? [],
      zoneLog: (got.get('zones') as AgentData['zoneLog']) ?? [],
    };
  }

  private async save(d: AgentData) {
    const { trades, signals, log, hourBars, zoneLog, ...core } = d;
    core.liveTrades = core.liveTrades.slice(-200);
    await this.ctx.storage.put({
      core,
      trades: trades.slice(-300),
      signals: signals.slice(-200),
      log: log.slice(-300),
      bars: hourBars,
      zones: zoneLog.slice(-400),
    });
  }

  private runner(d: AgentData): Runner {
    const creds: IgCredentials = {
      apiKey: this.env.IG_API_KEY,
      username: this.env.IG_USERNAME,
      password: this.env.IG_PASSWORD,
      env: this.env.IG_ENV === 'live' ? 'live' : 'demo',
      accountId: this.env.IG_ACCOUNT_ID?.trim() || undefined,
    };
    const ig = new IgClient(creds, d.tokens, (t) => {
      d.tokens = t;
    });
    return new Runner(d, ig, {
      priceEpic: this.env.PRICE_EPIC,
      warmupHours: 400,
      delay: 8,
      accountId: this.env.IG_ACCOUNT_ID?.trim() || undefined,
      trade: this.tradeSettings(),
    });
  }

  private tradeSettings(): TradeSettings | undefined {
    const e = this.env;
    if (!e.TRADE_EPIC?.trim()) return undefined;
    const num = (v: string | undefined, fallback: number) => (v != null && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback);
    const size = num(e.TRADE_SIZE, 0);
    if (!(size > 0)) return undefined;
    return {
      epic: e.TRADE_EPIC.trim(),
      size,
      guaranteedStop: (e.GUARANTEED_STOP ?? 'true').trim() !== 'false',
      maxTradesPerDay: num(e.MAX_TRADES_PER_DAY, 3),
      maxDailyLossPoints: num(e.MAX_DAILY_LOSS_POINTS, 100),
    };
  }

  private async ensureAlarm() {
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  async alarm() {
    await this.ctx.blockConcurrencyWhile(async () => {
      const d = await this.load();
      const next = await this.runner(d).tick();
      await this.save(d);
      await this.ctx.storage.setAlarm(next * 1000);
    });
  }

  /** Run a change to the stored data without overlapping a tick. */
  private async mutate<T>(fn: (r: Runner, d: AgentData) => Promise<T> | T): Promise<T> {
    let out!: T;
    await this.ctx.blockConcurrencyWhile(async () => {
      const d = await this.load();
      out = await fn(this.runner(d), d);
      await this.save(d);
    });
    return out;
  }

  /**
   * Long read-only IG work (market search, history download) runs outside the lock so it never
   * blocks a tick; afterwards only the session tokens and data allowance are written back.
   */
  private async outside<T>(fn: (r: Runner) => Promise<T>): Promise<T> {
    const d = await this.load();
    const r = this.runner(d);
    try {
      return await fn(r);
    } finally {
      await this.mutate((_r, fresh) => {
        fresh.tokens = d.tokens;
        fresh.allowance = r.data.allowance ?? fresh.allowance;
      });
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const token = url.searchParams.get('token') ?? '';
    const back = () => Response.redirect(`${url.origin}/?token=${encodeURIComponent(token)}`, 303);
    const missing = ['IG_API_KEY', 'IG_USERNAME', 'IG_PASSWORD'].filter((k) => !this.env[k as keyof Env]);

    try {
      switch (url.pathname) {
        case '/internal/ensure':
          await this.ensureAlarm();
          return new Response('ok');

        case '/':
        case '/api/status': {
          await this.ensureAlarm();
          const status = this.runner(await this.load()).status();
          if (missing.length) status.log.unshift({ time: Math.floor(Date.now() / 1000), level: 'error', msg: `Missing secrets: ${missing.join(', ')}` });
          if (url.pathname === '/api/status') return Response.json(status);
          return html(statusPage(status, token));
        }

        case '/api/pause':
        case '/api/resume':
          if (req.method !== 'POST') return new Response('POST only', { status: 405 });
          await this.mutate((r, d) => {
            d.paused = url.pathname === '/api/pause';
            r.log('info', d.paused ? 'Signals paused' : 'Signals resumed');
          });
          return back();

        case '/api/trading': {
          if (req.method !== 'POST') return new Response('POST only', { status: 405 });
          const form = await req.formData();
          const on = form.get('on') === '1';
          if (on && String(form.get('confirm') ?? '').trim().toUpperCase() !== 'ON') {
            return new Response('To turn on real trading, type ON in the box. Go back and try again.', { status: 400 });
          }
          await this.mutate((r) => r.setTrading(on));
          return back();
        }

        case '/api/close-now':
          if (req.method !== 'POST') return new Response('POST only', { status: 405 });
          await this.mutate((r) => r.closeNow());
          return back();

        case '/api/relogin':
          if (req.method !== 'POST') return new Response('POST only', { status: 405 });
          await this.mutate((r) => r.relogin());
          return back();

        case '/api/warmup':
          if (req.method !== 'POST') return new Response('POST only', { status: 405 });
          await this.mutate((r) => r.warmup(Date.now() / 1000));
          return back();

        case '/markets': {
          const q = (url.searchParams.get('q') ?? '').trim();
          const epic = (url.searchParams.get('epic') ?? '').trim();
          if (!q && !epic) return html(marketsPage('', null, token));
          try {
            const res = await this.outside((r) => r.findMarkets(q, epic || undefined));
            return html(marketsPage(q, res, token));
          } catch (e) {
            return html(marketsPage(q, null, token, e instanceof Error ? e.message : String(e)));
          }
        }

        case '/chart':
          return html(chartPage(token));

        case '/api/chart':
          return Response.json(this.runner(await this.load()).chartData());

        case '/history':
          return html(historyPage(token));

        case '/api/history.csv': {
          const resolution = (url.searchParams.get('resolution') ?? 'MINUTE_3') as Resolution;
          if (!['MINUTE_3', 'HOUR'].includes(resolution)) return new Response('resolution must be MINUTE_3 or HOUR', { status: 400 });
          const from = Date.parse(`${url.searchParams.get('from')}T00:00:00Z`) / 1000;
          const to = Date.parse(`${url.searchParams.get('to')}T23:59:59Z`) / 1000;
          if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return new Response('from/to must be dates like 2026-11-01', { status: 400 });
          const step = resolution === 'HOUR' ? 3600 : 180;
          // ~21 trading hours a day on 5 of 7 days
          const points = Math.ceil(((to - from) / step) * (5 / 7) * (21 / 24));
          if (url.searchParams.get('confirm') !== '1') {
            const d = await this.load();
            url.searchParams.set('confirm', '1');
            return html(historyPage(token, { points, remaining: d.allowance?.remainingAllowance ?? null, url: `${url.pathname}?${url.searchParams}` }));
          }
          const csv = await this.outside((r) => r.historyCsv(resolution, from, to));
          const name = `DE30_${resolution === 'HOUR' ? '1h' : '3m'}_${url.searchParams.get('from')}_${url.searchParams.get('to')}.csv`;
          return new Response(csv, { headers: { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="${name}"` } });
        }

        default:
          return new Response('Not found', { status: 404 });
      }
    } catch (e) {
      return new Response(`Error: ${e instanceof Error ? e.message : String(e)}`, { status: 500 });
    }
  }
}

const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
