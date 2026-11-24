/**
 * Minimal IG REST trading API client (https://labs.ig.com/rest-trading-api-reference).
 * Read-only for now: login, market search/details, accounts, prices.
 * Works in Cloudflare Workers and Node 18+ (uses global fetch).
 */
import type { Bar } from '../core/types';

export interface IgCredentials {
  apiKey: string;
  username: string;
  password: string;
  /** 'demo' -> demo-api.ig.com, 'live' -> api.ig.com */
  env: 'demo' | 'live';
  /** IG account the agent must use (e.g. "EY9UA"). Empty = whatever IG logs in to (the preferred account). */
  accountId?: string;
}

export interface IgTokens {
  cst: string;
  securityToken: string;
  accountId?: string;
  /** unix seconds when we logged in */
  at: number;
}

export interface IgAllowance {
  remainingAllowance: number;
  totalAllowance: number;
  allowanceExpiry: number;
}

export type Resolution = 'MINUTE' | 'MINUTE_2' | 'MINUTE_3' | 'MINUTE_5' | 'MINUTE_10' | 'MINUTE_15' | 'MINUTE_30' | 'HOUR' | 'HOUR_2' | 'HOUR_3' | 'HOUR_4' | 'DAY';

export interface IgPosition {
  dealId: string;
  dealReference: string | null;
  epic: string;
  direction: 'BUY' | 'SELL';
  size: number;
  level: number;
  stopLevel: number | null;
  limitLevel: number | null;
  guaranteed: boolean;
  createdUTC: string | null;
}

export interface IgConfirm {
  dealStatus: 'ACCEPTED' | 'REJECTED' | 'UNKNOWN';
  reason: string;
  dealId: string | null;
  level: number | null;
  stopLevel: number | null;
  limitLevel: number | null;
  profit: number | null;
  profitCurrency: string | null;
  affectedDeals: { dealId: string; status: string }[];
}

export class IgError extends Error {
  constructor(
    public status: number,
    public code: string,
    public path: string,
  ) {
    super(`IG ${status} ${code} (${path})`);
  }
}

type FetchFn = typeof fetch;

interface PriceSide {
  bid: number | null;
  ask: number | null;
  lastTraded: number | null;
}
interface IgPrice {
  snapshotTime: string;
  snapshotTimeUTC?: string;
  openPrice: PriceSide;
  highPrice: PriceSide;
  lowPrice: PriceSide;
  closePrice: PriceSide;
}

export class IgClient {
  private tokens: IgTokens | null;
  lastAllowance: IgAllowance | null = null;

  constructor(
    private creds: IgCredentials,
    tokens: IgTokens | null = null,
    /** called whenever tokens change, so the caller can persist them */
    private onTokens: (t: IgTokens | null) => void = () => {},
    private fetchFn: FetchFn = (...a) => fetch(...a),
  ) {
    this.tokens = tokens;
  }

  get base(): string {
    return this.creds.env === 'live' ? 'https://api.ig.com/gateway/deal' : 'https://demo-api.ig.com/gateway/deal';
  }

  private headers(version: number): Record<string, string> {
    const h: Record<string, string> = {
      'X-IG-API-KEY': this.creds.apiKey,
      'Content-Type': 'application/json; charset=UTF-8',
      Accept: 'application/json; charset=UTF-8',
      Version: String(version),
    };
    if (this.tokens) {
      h.CST = this.tokens.cst;
      h['X-SECURITY-TOKEN'] = this.tokens.securityToken;
    }
    return h;
  }

  private async send(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(`${this.base}${path}`, init);
    } catch (e) {
      throw new Error(`Could not reach IG (${this.creds.env}) for ${path.split('?')[0]}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private pendingLogin: Promise<IgTokens> | null = null;
  private pendingSwitch: Promise<void> | null = null;

  /** Log in (parallel callers share one login). */
  login(): Promise<IgTokens> {
    if (!this.pendingLogin) {
      this.pendingLogin = this.doLogin().finally(() => {
        this.pendingLogin = null;
      });
    }
    return this.pendingLogin;
  }

  private async doLogin(): Promise<IgTokens> {
    const res = await this.send('/session', {
      method: 'POST',
      headers: { ...this.headers(2), CST: '', 'X-SECURITY-TOKEN': '' },
      body: JSON.stringify({ identifier: this.creds.username, password: this.creds.password }),
    });
    if (!res.ok) throw new IgError(res.status, await errorCode(res), '/session');
    const body = (await res.json()) as { currentAccountId?: string };
    const cst = res.headers.get('CST');
    const sec = res.headers.get('X-SECURITY-TOKEN');
    if (!cst || !sec) throw new IgError(res.status, 'missing-session-tokens', '/session');
    this.tokens = { cst, securityToken: sec, accountId: body.currentAccountId, at: Math.floor(Date.now() / 1000) };
    this.onTokens(this.tokens);
    return this.tokens;
  }

  /** Make sure the session is on the configured account (switches with PUT /session if not). */
  async ensureAccount() {
    const want = this.creds.accountId;
    if (!want || !this.tokens || this.tokens.accountId === want) return;
    if (!this.pendingSwitch) {
      this.pendingSwitch = this.switchAccount(want).finally(() => {
        this.pendingSwitch = null;
      });
    }
    await this.pendingSwitch;
  }

  /** GET/POST/PUT with automatic login and one re-login on an expired/invalid token. */
  async request<T>(method: string, path: string, version: number, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    if (path !== '/session') {
      // every normal call: be logged in, on the right account (shared between parallel calls)
      if (!this.tokens) await this.login();
      await this.ensureAccount();
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.send(path, {
        method,
        headers: { ...this.headers(version), ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.ok) {
        // IG may hand out fresh session tokens (e.g. after an account switch)
        const cst = res.headers.get('CST');
        const sec = res.headers.get('X-SECURITY-TOKEN');
        if (this.tokens && (cst || sec)) {
          this.tokens = { ...this.tokens, cst: cst ?? this.tokens.cst, securityToken: sec ?? this.tokens.securityToken };
          this.onTokens(this.tokens);
        }
        const text = await res.text();
        return (text ? JSON.parse(text) : {}) as T;
      }
      const code = await errorCode(res);
      const tokenProblem = res.status === 401 || /token|security/i.test(code);
      if (attempt === 0 && tokenProblem && path !== '/session') {
        this.tokens = null;
        this.onTokens(null);
        await this.login();
        await this.ensureAccount();
        continue;
      }
      throw new IgError(res.status, code, path);
    }
    throw new IgError(0, 'unreachable', path);
  }

  /** The account the session is on (null before login). */
  get currentAccountId(): string | null {
    return this.tokens?.accountId ?? null;
  }

  accounts() {
    return this.request<{
      accounts: {
        accountId: string;
        accountName: string;
        accountType: string;
        preferred: boolean;
        status?: string;
        currency?: string;
        balance?: { balance: number; deposit: number; profitLoss: number; available: number };
      }[];
    }>(
      'GET',
      '/accounts',
      1,
    );
  }

  /** Switch the session to another of your accounts. */
  async switchAccount(accountId: string, fresh = false): Promise<void> {
    if (this.tokens?.accountId === accountId) return;
    try {
      await this.request('PUT', '/session', 1, { accountId, defaultAccount: false });
    } catch (e) {
      const stale = e instanceof IgError && (e.status === 401 || /token|security/i.test(e.code));
      if (stale && !fresh) {
        // the stored session has expired: log in again (login switches account itself)
        this.resetSession();
        await this.login();
        return this.switchAccount(accountId, true);
      }
      // IG answers this when the session is already on that account
      if (!(e instanceof IgError && /must-be-different/i.test(e.code))) {
        throw new Error(`Could not switch to IG account ${accountId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (this.tokens) {
      this.tokens.accountId = accountId;
      this.onTokens(this.tokens);
    }
  }

  searchMarkets(term: string) {
    return this.request<{
      markets: { epic: string; instrumentName: string; instrumentType: string; expiry: string; bid: number | null; offer: number | null; marketStatus: string }[];
    }>('GET', `/markets?searchTerm=${encodeURIComponent(term)}`, 1);
  }

  market(epic: string, version = 3) {
    return this.request<{
      instrument: Record<string, unknown> & { epic: string; name: string; type: string };
      dealingRules: Record<string, { unit: string; value: number } | string>;
      snapshot: Record<string, unknown> & { marketStatus: string; bid: number | null; offer: number | null };
    }>('GET', `/markets/${encodeURIComponent(epic)}`, version);
  }

  /** Market details, trying API versions 3, 2 and 1 (some instruments fail on newer versions). */
  async marketAnyVersion(epic: string) {
    const errors: { version: number; error: string }[] = [];
    for (const version of [3, 2, 1]) {
      try {
        return { version, data: await this.market(epic, version), errors };
      } catch (e) {
        if (!(e instanceof IgError)) throw e;
        errors.push({ version, error: e.message });
      }
    }
    return { version: null, data: null, errors };
  }

  // ---------- dealing ----------

  /** Open positions on the current account. */
  async positions(): Promise<IgPosition[]> {
    const r = await this.request<{ positions: { position: Record<string, unknown>; market: Record<string, unknown> }[] }>('GET', '/positions', 2);
    return (r.positions ?? []).map(({ position: p, market: m }) => ({
      dealId: String(p.dealId),
      dealReference: p.dealReference ? String(p.dealReference) : null,
      epic: String(m.epic),
      direction: p.direction as 'BUY' | 'SELL',
      size: Number(p.size ?? p.dealSize),
      level: Number(p.level ?? p.openLevel),
      stopLevel: p.stopLevel == null ? null : Number(p.stopLevel),
      limitLevel: p.limitLevel == null ? null : Number(p.limitLevel),
      guaranteed: Boolean(p.controlledRisk),
      createdUTC: p.createdDateUTC ? String(p.createdDateUTC) : null,
    }));
  }

  /** Market order with stop and limit given as distances. Returns IG's deal reference. */
  async openMarket(o: {
    epic: string;
    direction: 'BUY' | 'SELL';
    size: number;
    currencyCode: string;
    stopDistance: number;
    limitDistance: number;
    guaranteedStop: boolean;
    dealReference: string;
  }): Promise<string> {
    const r = await this.request<{ dealReference: string }>('POST', '/positions/otc', 2, {
      epic: o.epic,
      expiry: '-',
      direction: o.direction,
      size: o.size,
      orderType: 'MARKET',
      timeInForce: 'FILL_OR_KILL',
      level: null,
      quoteId: null,
      currencyCode: o.currencyCode,
      forceOpen: true,
      guaranteedStop: o.guaranteedStop,
      stopLevel: null,
      stopDistance: o.stopDistance,
      limitLevel: null,
      limitDistance: o.limitDistance,
      trailingStop: false,
      trailingStopIncrement: null,
      dealReference: o.dealReference,
    });
    return r.dealReference ?? o.dealReference;
  }

  /** Close (part of) a position at market. IG wants DELETE with a body, sent as POST + _method header. */
  async closeMarket(dealId: string, direction: 'BUY' | 'SELL', size: number): Promise<string> {
    const r = await this.request<{ dealReference: string }>(
      'POST',
      '/positions/otc',
      1,
      { dealId, epic: null, expiry: null, direction, size, level: null, orderType: 'MARKET', timeInForce: null, quoteId: null },
      { _method: 'DELETE' },
    );
    return r.dealReference;
  }

  /** Outcome of a deal (accepted/rejected, fill level, ids). Null when IG does not know the reference (yet). */
  async confirm(dealReference: string): Promise<IgConfirm | null> {
    try {
      const c = await this.request<Record<string, unknown>>('GET', `/confirms/${encodeURIComponent(dealReference)}`, 1);
      return {
        dealStatus: String(c.dealStatus) as IgConfirm['dealStatus'],
        reason: String(c.reason ?? ''),
        dealId: c.dealId ? String(c.dealId) : null,
        level: c.level == null ? null : Number(c.level),
        stopLevel: c.stopLevel == null ? null : Number(c.stopLevel),
        limitLevel: c.limitLevel == null ? null : Number(c.limitLevel),
        profit: c.profit == null ? null : Number(c.profit),
        profitCurrency: c.profitCurrency ? String(c.profitCurrency) : null,
        affectedDeals: (c.affectedDeals as { dealId: string; status: string }[] | undefined) ?? [],
      };
    } catch (e) {
      if (e instanceof IgError && e.status === 404) return null;
      throw e;
    }
  }

  /** Forget the stored session; the next call logs in again. */
  resetSession() {
    this.tokens = null;
    this.onTokens(null);
  }

  /** The newest `max` bars (oldest first). The last one may still be forming. */
  async latestBars(epic: string, resolution: Resolution, max: number): Promise<Bar[]> {
    const q = `resolution=${resolution}&max=${max}&pageSize=0`;
    const r = await this.request<{ prices: IgPrice[]; metadata?: { allowance?: IgAllowance } }>('GET', `/prices/${encodeURIComponent(epic)}?${q}`, 3);
    if (r.metadata?.allowance) this.lastAllowance = r.metadata.allowance;
    return toBars(r.prices);
  }

  /** Bars between two times (unix seconds), paging through IG's results. Oldest first. */
  async barsBetween(epic: string, resolution: Resolution, from: number, to: number): Promise<Bar[]> {
    const out: Bar[] = [];
    for (let page = 1; page < 200; page++) {
      const q = `resolution=${resolution}&from=${igTime(from)}&to=${igTime(to)}&pageSize=1000&pageNumber=${page}`;
      const r = await this.request<{
        prices: IgPrice[];
        metadata?: { allowance?: IgAllowance; pageData?: { pageNumber: number; totalPages: number } };
      }>('GET', `/prices/${encodeURIComponent(epic)}?${q}`, 3);
      if (r.metadata?.allowance) this.lastAllowance = r.metadata.allowance;
      out.push(...toBars(r.prices));
      const pd = r.metadata?.pageData;
      if (!pd || pd.pageNumber >= pd.totalPages) break;
    }
    out.sort((a, b) => a.time - b.time);
    return out.filter((b, i) => i === 0 || b.time !== out[i - 1].time);
  }
}

async function errorCode(res: Response): Promise<string> {
  try {
    const t = await res.text();
    const j = JSON.parse(t) as { errorCode?: string };
    return j.errorCode ?? t.slice(0, 200);
  } catch {
    return `http-${res.status}`;
  }
}

/** IG time format for query strings: yyyy-MM-ddTHH:mm:ss (UTC) */
export function igTime(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 19);
}

const mid = (p: PriceSide): number | null => {
  if (p.bid != null && p.ask != null) return (p.bid + p.ask) / 2;
  return p.bid ?? p.ask ?? p.lastTraded ?? null;
};

/** IG price rows -> mid-price bars (time = bar open, unix seconds UTC). */
export function toBars(prices: IgPrice[]): Bar[] {
  const out: Bar[] = [];
  for (const p of prices ?? []) {
    const iso = p.snapshotTimeUTC ? `${p.snapshotTimeUTC}Z` : null;
    const time = iso ? Date.parse(iso) / 1000 : NaN;
    const o = mid(p.openPrice);
    const h = mid(p.highPrice);
    const l = mid(p.lowPrice);
    const c = mid(p.closePrice);
    if (!Number.isFinite(time) || o == null || h == null || l == null || c == null) continue;
    out.push({ time, open: o, high: Math.max(h, o, c), low: Math.min(l, o, c), close: c });
  }
  return out.sort((a, b) => a.time - b.time);
}
