import type { Bar } from '../core/types';

/**
 * Read OHLC bars from CSV. Works with TradingView's "Export chart data" files
 * (columns: time,open,high,low,close,...) and similar exports.
 * `time` may be unix seconds, unix milliseconds or an ISO date string.
 */
export function parseBars(text: string): Bar[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return [];
  const sep = lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',';
  const header = lines[0].split(sep).map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ''));
  const col = (...names: string[]) => {
    const i = header.findIndex((h) => names.includes(h));
    if (i < 0) throw new Error(`CSV is missing a column: ${names.join(' / ')} (found: ${header.join(', ')})`);
    return i;
  };
  const it = col('time', 'date', 'datetime', 'timestamp');
  const io = col('open');
  const ih = col('high');
  const il = col('low');
  const ic = col('close');

  const bars: Bar[] = [];
  for (const line of lines.slice(1)) {
    const f = line.split(sep).map((x) => x.trim().replace(/^"|"$/g, ''));
    const time = parseTime(f[it]);
    const bar = { time, open: +f[io], high: +f[ih], low: +f[il], close: +f[ic] };
    if ([bar.time, bar.open, bar.high, bar.low, bar.close].some((v) => !Number.isFinite(v))) continue;
    bars.push(bar);
  }
  bars.sort((a, b) => a.time - b.time);
  // drop duplicate timestamps
  return bars.filter((b, i) => i === 0 || b.time !== bars[i - 1].time);
}

function parseTime(s: string): number {
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return n > 1e11 ? Math.floor(n / 1000) : n;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? NaN : Math.floor(t / 1000);
}

/** Build bars of `seconds` length (aligned to UTC multiples) from shorter bars. */
export function aggregate(bars: Bar[], seconds: number): Bar[] {
  const out: Bar[] = [];
  let cur: Bar | null = null;
  for (const b of bars) {
    const t = Math.floor(b.time / seconds) * seconds;
    if (!cur || cur.time !== t) {
      if (cur) out.push(cur);
      cur = { time: t, open: b.open, high: b.high, low: b.low, close: b.close };
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const keys = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [keys.join(','), ...rows.map((r) => keys.map((k) => esc(r[k])).join(','))].join('\n') + '\n';
}
