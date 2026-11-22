/**
 * Synthetic DAX-like 3m bars for testing the pipeline only (no real market data).
 * Random walk with volatility clusters and occasional impulses so imbalance zones appear.
 *   npm run sample-data -- [weeks=8] [seed=7]
 */
import { mkdirSync, writeFileSync } from 'node:fs';

const weeks = Number(process.argv[2] ?? 8);
let seed = Number(process.argv[3] ?? 7);
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

const start = Date.UTC(2026, 8, 7, 0, 0) / 1000; // a Monday, 00:00 UTC
let price = 24000;
let impulse = 0;
let impulseBars = 0;
const rows = ['time,open,high,low,close'];

for (let t = start; t < start + weeks * 7 * 86400; t += 180) {
  const d = new Date(t * 1000);
  const wd = d.getUTCDay();
  const h = d.getUTCHours();
  if (wd === 0 || wd === 6 || h >= 21) continue; // IG-like: weekdays, closed late evening
  const session = h >= 7 && h < 16 ? 1.6 : 0.7;
  if (impulseBars <= 0 && rand() < 0.004) {
    impulse = (rand() < 0.5 ? -1 : 1) * (2 + rand() * 4);
    impulseBars = 10 + Math.floor(rand() * 25);
  }
  const drift = impulseBars-- > 0 ? impulse : 0;
  const open = price;
  const steps = 6;
  let hi = open;
  let lo = open;
  for (let i = 0; i < steps; i++) {
    price += (gauss() * 2.2 * session + drift / steps);
    hi = Math.max(hi, price);
    lo = Math.min(lo, price);
  }
  const f = (n: number) => n.toFixed(1);
  rows.push(`${t},${f(open)},${f(hi)},${f(lo)},${f(price)}`);
}
mkdirSync('data', { recursive: true });
writeFileSync('data/sample_3m.csv', rows.join('\n') + '\n');
console.log(`Wrote data/sample_3m.csv (${rows.length - 1} bars, synthetic)`);
