/**
 * Usage:
 *   npm run backtest -- --entry data/DE30_3m.csv [--hour data/DE30_1h.csv] [--out out] [--set stopPoints=25 ...]
 *
 * --entry  3-minute bars (TradingView "Export chart data" CSV). Required.
 * --hour   1-hour bars. Optional: if left out, 1h bars are built from the 3m file.
 *          Give it to get more 1h history (zones and Monday levels before the 3m data starts).
 * --set    override any rule in src/core/config.ts, e.g. --set minScore=1 --set mondayNoScore=false
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultConfig, type Config } from '../core/config';
import { local } from '../core/time';
import { aggregate, parseBars, toCsv } from './csv';
import { makePine } from './pine';
import { runBacktest, summarize } from './simulate';

function args() {
  const a = process.argv.slice(2);
  const out: { entry?: string; hour?: string; out: string; set: string[] } = { out: 'out', set: [] };
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    const v = a[++i];
    if (k === '--entry') out.entry = v;
    else if (k === '--hour') out.hour = v;
    else if (k === '--out') out.out = v;
    else if (k === '--set') out.set.push(v);
    else throw new Error(`Unknown option ${k}`);
  }
  if (!out.entry) throw new Error('Missing --entry <3m csv>');
  return out;
}

function applySets(sets: string[]): Config {
  const cfg: Config = { ...defaultConfig };
  for (const s of sets) {
    const [k, v] = s.split('=');
    if (!(k in cfg)) throw new Error(`Unknown setting ${k}`);
    const cur = (cfg as unknown as Record<string, unknown>)[k];
    (cfg as unknown as Record<string, unknown>)[k] =
      typeof cur === 'number' ? Number(v) : typeof cur === 'boolean' ? v === 'true' : v;
  }
  return cfg;
}

const o = args();
const cfg = applySets(o.set);
const entryBars = parseBars(readFileSync(o.entry!, 'utf8'));
const hourBars = o.hour ? parseBars(readFileSync(o.hour, 'utf8')) : aggregate(entryBars, 3600);
if (!entryBars.length || !hourBars.length) throw new Error('No bars found in the CSV file(s).');

const step = entryBars.length > 1 ? entryBars[1].time - entryBars[0].time : 0;
if (step && step !== cfg.entryBarSeconds) {
  console.warn(`Warning: entry bars look like ${step / 60}-minute bars, expected ${cfg.entryBarSeconds / 60}.`);
}

const res = runBacktest(hourBars, entryBars, cfg);
const sum = summarize(res.trades);

const fmt = (t: number) => {
  const l = local(t, cfg.tz);
  const hh = String(Math.floor(l.minutes / 60)).padStart(2, '0');
  const mm = String(l.minutes % 60).padStart(2, '0');
  return `${l.date} ${hh}:${mm}`;
};
const r1 = (n: number) => Math.round(n * 10) / 10;

mkdirSync(o.out, { recursive: true });
writeFileSync(
  join(o.out, 'trades.csv'),
  toCsv(
    res.trades.map((t) => ({
      entry_time: fmt(t.entryTime),
      side: t.side,
      trigger: t.trigger,
      score: t.score,
      score_parts: t.scoreParts.join(' '),
      entry: r1(t.entry),
      stop: r1(t.stop),
      target: r1(t.target),
      exit_time: fmt(t.exitTime),
      exit: r1(t.exit),
      exit_reason: t.exitReason,
      points: r1(t.points),
      zone: t.zoneId,
    })),
  ),
);
writeFileSync(
  join(o.out, 'zones.csv'),
  toCsv(
    res.zones.map((z) => ({
      id: z.id,
      side: z.side,
      created: fmt(z.createdAt),
      low: r1(z.origLow),
      high: r1(z.origHigh),
      width: r1(z.origHigh - z.origLow),
      status: z.traded ? 'traded' : z.alive ? (z.expiredAt ? 'expired' : 'open') : 'filled',
      ended: z.diedAt ? fmt(z.diedAt) : z.expiredAt ? fmt(z.expiredAt) : '',
    })),
  ),
);
writeFileSync(join(o.out, 'mondays.csv'), toCsv(res.mondays.map((m) => ({ ...m, mid: r1(m.mid) }))));
writeFileSync(join(o.out, 'bias.csv'), toCsv(res.biasChanges.map((b) => ({ ...b, time: fmt(b.time) }))));
writeFileSync(join(o.out, 'overlay.pine'), makePine(res));

const lines = [
  `DE30 zone strategy backtest`,
  `3m data: ${fmt(res.firstEntryBar!)} -> ${fmt(res.lastEntryBar!)}  (${entryBars.length} bars, ${hourBars.length} 1h bars)`,
  `Rules: stop ${cfg.stopPoints} pts, target ${cfg.stopPoints * cfg.rewardRisk} pts, min score ${cfg.minScore}, max zone ${cfg.maxZoneWidth} pts, spread ${cfg.spreadPoints} pts`,
  ``,
  `Zones found: ${res.zones.length}   Weeks with Monday levels: ${res.mondays.length}   Bias changes: ${res.biasChanges.length}`,
  `Trades: ${sum.trades}   Wins: ${sum.wins}   Losses: ${sum.losses}   Win rate: ${(sum.winRate * 100).toFixed(0)}%`,
  `Total: ${r1(sum.totalPoints)} pts   Avg/trade: ${r1(sum.avgPoints)} pts   Max drawdown: ${r1(sum.maxDrawdown)} pts`,
  `Exits: ${Object.entries(sum.byExit).map(([k, v]) => `${k} ${v}`).join(', ') || '-'}`,
  `By score: ${Object.entries(sum.byScore).map(([k, v]) => `${k}: ${v.trades} trades / ${r1(v.points)} pts`).join(' | ') || '-'}`,
  `By trigger: ${Object.entries(sum.byTrigger).map(([k, v]) => `${k}: ${v.trades} trades / ${r1(v.points)} pts`).join(' | ') || '-'}`,
  ``,
  `Files in ${o.out}/: trades.csv, zones.csv, mondays.csv, bias.csv, overlay.pine`,
];
writeFileSync(join(o.out, 'summary.txt'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
