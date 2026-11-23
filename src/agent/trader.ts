/**
 * Real trading on IG. Every order goes through `open()`, which refuses unless ALL checks pass:
 * the switch is on, no position open (ours or anyone else's on this market), the signal is fresh,
 * daily caps not reached, the market is tradeable, the size and stop distance are allowed.
 * Stops and targets are sent with the order, so IG holds them even if the agent goes down.
 */
import type { Config } from '../core/config';
import { checkExit } from '../core/paper';
import { local } from '../core/time';
import type { Bar, Side, Signal } from '../core/types';
import type { IgClient, IgConfirm, IgPosition } from '../ig/client';

export interface TradeSettings {
  epic: string;
  size: number;
  guaranteedStop: boolean;
  maxTradesPerDay: number;
  maxDailyLossPoints: number;
}

export interface LivePosition {
  dealId: string;
  dealReference: string;
  side: Side;
  size: number;
  entry: number;
  stopLevel: number | null;
  limitLevel: number | null;
  openedAt: number;
  zoneId: string;
  /** first stop/target touch seen in our 3m bars (used if IG closes the position) */
  hit?: { time: number; price: number; reason: 'stop' | 'target' };
  /** IG no longer lists the position; recorded once this run's bars are read */
  goneAt?: number;
}

export interface LiveTrade {
  dealId: string;
  side: Side;
  size: number;
  zoneId: string;
  openedAt: number;
  entry: number;
  closedAt: number;
  exit: number | null;
  reason: 'stop' | 'target' | 'session-end' | 'manual' | 'closed-at-ig';
  /** index points, before any IG charges; null if unknown */
  points: number | null;
  /** exit taken from our own price bars, not from IG */
  estimated: boolean;
}

/** The part of the agent's stored data the trader uses. */
export interface TraderData {
  trading: boolean;
  live: LivePosition | null;
  liveTrades: LiveTrade[];
  /** description of other open positions on the trade market (blocks new orders) */
  foreign: string | null;
}

type Log = (level: 'info' | 'warn' | 'error', msg: string, time?: number) => void;

export const REF_PREFIX = 'ALV';
const GSL_PREMIUM_FALLBACK = 2;

export class Trader {
  constructor(
    private d: TraderData,
    private ig: IgClient,
    private s: TradeSettings,
    private cfg: Config,
    private log: Log,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Trades opened today and points won/lost today (local time). Unknown results count as a full loss. */
  today(now: number) {
    const day = local(now, this.cfg.tz).date;
    const onDay = (t: number) => local(t, this.cfg.tz).date === day;
    const worst = -(this.cfg.stopPoints + (this.s.guaranteedStop ? GSL_PREMIUM_FALLBACK : 0));
    const closed = this.d.liveTrades.filter((t) => onDay(t.openedAt));
    const opened = closed.length + (this.d.live && onDay(this.d.live.openedAt) ? 1 : 0);
    const points = closed.reduce((sum, t) => sum + (t.points ?? worst), 0);
    return { opened, points };
  }

  /** Compare with IG's open positions: detect closes done by IG, recover our own, notice others. */
  async reconcile(now: number) {
    const onMarket = (await this.ig.positions()).filter((p) => p.epic === this.s.epic);
    const d = this.d;
    if (d.live) {
      const still = onMarket.find((p) => p.dealId === d.live!.dealId);
      if (!still) {
        // closed by IG (stop or target): finish it after this run's bars show which one
        d.live.goneAt = now;
      } else {
        d.live.stopLevel = still.stopLevel;
        d.live.limitLevel = still.limitLevel;
      }
    } else {
      const ours = onMarket.find((p) => p.dealReference?.startsWith(REF_PREFIX));
      if (ours) {
        d.live = fromPosition(ours, 'unknown', now);
        this.log('warn', `Found the agent's own open position at IG (${ours.dealId}); managing it again`, now);
      }
    }
    const others = onMarket.filter((p) => p.dealId !== d.live?.dealId);
    const desc = others.length ? `${others.length} other open position(s) on ${this.s.epic}` : null;
    if (desc && desc !== d.foreign) this.log('warn', `${desc}: no new orders until they are closed`, now);
    d.foreign = desc;
  }

  /** Watch the open position against each new 3m bar, to know whether IG hit the stop or the target. */
  trackBar(bar: Bar, closeTime: number) {
    const p = this.d.live;
    if (!p || p.hit || p.stopLevel == null || p.limitLevel == null || closeTime <= p.openedAt) return;
    const asSignal = { side: p.side, stop: p.stopLevel, target: p.limitLevel } as Signal;
    const exit = checkExit(asSignal, bar, this.cfg);
    if (exit && exit.reason !== 'session-end' && exit.reason !== 'end-of-data') {
      p.hit = { time: closeTime, price: exit.reason === 'stop' ? p.stopLevel : p.limitLevel, reason: exit.reason };
    }
  }

  /** Record a position IG has closed, using the stop/target touch seen in the bars. Call after the bars. */
  finishClosed(now: number) {
    const p = this.d.live;
    if (!p?.goneAt) return;
    const h = p.hit;
    if (h) this.record(h.time, h.price, h.reason, true);
    else {
      this.log('warn', 'Position was closed at IG but our prices show no stop or target touch; exit unknown (check IG)', now);
      this.record(p.goneAt, null, 'closed-at-ig', true);
    }
  }

  /** Try to open a real position for an entry signal. Returns true if a position was opened. */
  async open(sig: Signal, now: number): Promise<boolean> {
    const d = this.d;
    const skip = (msg: string, level: 'info' | 'warn' = 'info') => {
      this.log(level, `No order: ${msg}`, now);
      return false;
    };
    if (!d.trading) return false;
    if (d.live) return skip('a position is already open');
    if (d.foreign) return skip(d.foreign, 'warn');
    if (now - sig.time > 2 * this.cfg.entryBarSeconds + 60) return skip(`signal is ${Math.round((now - sig.time) / 60)} min old`, 'warn');
    const t = this.today(now);
    if (t.opened >= this.s.maxTradesPerDay) return skip(`daily limit of ${this.s.maxTradesPerDay} trades reached`);
    if (t.points <= -this.s.maxDailyLossPoints) return skip(`daily loss limit reached (${t.points.toFixed(1)} pts)`);

    // market checks
    const m = await this.ig.market(this.s.epic);
    const rules = m.dealingRules as Record<string, { value: number } | undefined>;
    const status = String(m.snapshot.marketStatus);
    if (status !== 'TRADEABLE') return skip(`market is ${status}`, 'warn');
    const min = rules.minDealSize?.value ?? 0;
    if (this.s.size < min) return skip(`size ${this.s.size} is below IG's minimum ${min}`, 'warn');
    const minStop = (this.s.guaranteedStop ? rules.minControlledRiskStopDistance?.value : rules.minNormalStopOrLimitDistance?.value) ?? 0;
    if (this.cfg.stopPoints < minStop) return skip(`stop ${this.cfg.stopPoints} is closer than IG allows (${minStop})`, 'warn');
    const currencies = (m.instrument.currencies as { code: string; isDefault?: boolean }[] | undefined) ?? [];
    const currency = (currencies.find((c) => c.isDefault) ?? currencies[0])?.code;
    if (!currency) return skip('market has no currency', 'warn');

    const direction = sig.side === 'buy' ? 'BUY' : 'SELL';
    const ref = newRef();
    let sendError: unknown = null;
    try {
      await this.ig.openMarket({
        epic: this.s.epic,
        direction,
        size: this.s.size,
        currencyCode: currency,
        stopDistance: this.cfg.stopPoints,
        limitDistance: this.cfg.stopPoints * this.cfg.rewardRisk,
        guaranteedStop: this.s.guaranteedStop,
        dealReference: ref,
      });
    } catch (e) {
      // the answer may be lost although IG took the order: check before giving up
      sendError = e;
    }
    const c = await this.confirmOrFind(ref);
    if (c?.dealStatus === 'ACCEPTED' && c.dealId) {
      d.live = {
        dealId: c.dealId,
        dealReference: ref,
        side: sig.side,
        size: this.s.size,
        entry: c.level ?? sig.price,
        stopLevel: c.stopLevel,
        limitLevel: c.limitLevel,
        openedAt: now,
        zoneId: sig.zoneId,
      };
      this.log(
        'info',
        `ORDER FILLED ${direction} ${this.s.size} at ${f1(d.live.entry)}, stop ${f1(c.stopLevel)}${this.s.guaranteedStop ? ' (guaranteed)' : ''}, target ${f1(c.limitLevel)}`,
        now,
      );
      return true;
    }
    if (c?.dealStatus === 'REJECTED') return skip(`IG rejected the order (${c.reason})`, 'warn');
    const why = sendError instanceof Error ? sendError.message : 'no confirmation from IG';
    this.log('error', `Order status unknown (${why}); checking IG positions on the next run`, now);
    return false;
  }

  /** Close our open position at market. */
  async close(reason: 'session-end' | 'manual', now: number): Promise<boolean> {
    const p = this.d.live;
    if (!p || p.goneAt) return false;
    try {
      const ref = await this.ig.closeMarket(p.dealId, p.side === 'buy' ? 'SELL' : 'BUY', p.size);
      const c = await this.confirmOrFind(ref);
      if (c?.dealStatus === 'ACCEPTED') {
        this.record(now, c.level, reason, false);
        return true;
      }
      this.log('warn', `Close not confirmed (${c ? c.reason : 'no answer'}); will check again`, now);
    } catch (e) {
      this.log('error', `Close failed: ${e instanceof Error ? e.message : String(e)}; will try again`, now);
    }
    return false;
  }

  private async confirmOrFind(ref: string): Promise<IgConfirm | null> {
    for (let i = 0; i < 3; i++) {
      try {
        const c = await this.ig.confirm(ref);
        if (c) return c;
      } catch {
        /* try again */
      }
      await this.sleep(700);
    }
    return null;
  }

  private record(time: number, exit: number | null, reason: LiveTrade['reason'], estimated: boolean) {
    const p = this.d.live!;
    const sign = p.side === 'buy' ? 1 : -1;
    const points = exit == null ? null : (exit - p.entry) * sign;
    this.d.liveTrades.push({
      dealId: p.dealId,
      side: p.side,
      size: p.size,
      zoneId: p.zoneId,
      openedAt: p.openedAt,
      entry: p.entry,
      closedAt: time,
      exit,
      reason,
      points,
      estimated,
    });
    if (this.d.liveTrades.length > 200) this.d.liveTrades.splice(0, this.d.liveTrades.length - 200);
    this.d.live = null;
    this.log('info', `POSITION CLOSED (${reason}) at ${f1(exit)}: ${points == null ? 'result unknown' : `${points >= 0 ? '+' : ''}${points.toFixed(1)} pts`}${estimated ? ' (from our prices)' : ''}`, time);
  }
}

function fromPosition(p: IgPosition, zoneId: string, now: number): LivePosition {
  return {
    dealId: p.dealId,
    dealReference: p.dealReference ?? '',
    side: p.direction === 'BUY' ? 'buy' : 'sell',
    size: p.size,
    entry: p.level,
    stopLevel: p.stopLevel,
    limitLevel: p.limitLevel,
    openedAt: p.createdUTC ? Date.parse(`${p.createdUTC.replace(' ', 'T')}Z`) / 1000 || now : now,
    zoneId,
  };
}

function newRef(): string {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${REF_PREFIX}${Date.now().toString(36)}${rnd}`.slice(0, 30);
}

const f1 = (n: number | null | undefined) => (n == null ? '-' : n.toFixed(1));
