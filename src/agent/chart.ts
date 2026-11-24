/**
 * Chart page: 1h candles with the zones, Monday levels, bias changes and trades the agent sees.
 * Uses TradingView's open-source Lightweight Charts (Apache-2.0) from a CDN; zones and Monday
 * levels are drawn on a canvas layered over the chart.
 */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function chartPage(token: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>autolevels chart</title>
<style>
  body{font:14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f6f7f9;color:#1d2330}
  header{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;padding:10px 14px}
  h1{font-size:17px;margin:0} a{color:#2457c5}
  label{white-space:nowrap;font-size:13px}
  #wrap{position:relative;height:calc(100vh - 150px);min-height:360px;margin:0 8px;background:#fff;border:1px solid #e3e6ec;border-radius:8px;overflow:hidden}
  #chart{position:absolute;inset:0;z-index:1} #overlay{position:absolute;inset:0;pointer-events:none;z-index:5}
  .legend{display:flex;flex-wrap:wrap;gap:6px 14px;padding:8px 14px;font-size:12px;color:#4a5263}
  .sw{display:inline-block;width:12px;height:12px;border-radius:2px;vertical-align:-2px;margin-right:4px}
  #msg{padding:20px;color:#8a93a5}
</style></head><body>
<header>
  <h1>Chart · Germany 40, 1h</h1>
  <label><input type="checkbox" id="dead"> filled / expired zones</label>
  <label><input type="checkbox" id="paper" checked> paper trades</label>
  <label><input type="checkbox" id="bias" checked> bias changes</label>
  <a href="/?token=${encodeURIComponent(token)}">Back to status</a>
</header>
<div id="wrap"><div id="chart"></div><canvas id="overlay"></canvas><div id="msg">Loading…</div></div>
<div class="legend">
  <span><span class="sw" style="background:rgba(10,125,85,.25);border:1px solid #0a7d55"></span>buy zone</span>
  <span><span class="sw" style="background:rgba(192,57,43,.22);border:1px solid #c0392b"></span>sell zone</span>
  <span><span class="sw" style="background:rgba(10,125,85,.22);border:1.5px solid #0a7d55"></span>order block (solid edge)</span>
  <span><span class="sw" style="border:2px solid #2457c5"></span>traded zone</span>
  <span><span class="sw" style="background:rgba(120,130,145,.18)"></span>filled / expired</span>
  <span><span class="sw" style="background:#e67e22"></span>Monday high / low (dashed: mid)</span>
  <span>Numbers on zones: score now. Times: Oslo.</span>
</div>
<script src="https://cdn.jsdelivr.net/npm/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js"></script>
<script>
const TOKEN = ${JSON.stringify(token).replace(/</g, '\\u003c')};
const TZ = 'Europe/Oslo';
const fmt = (opts) => new Intl.DateTimeFormat('en-GB', Object.assign({ timeZone: TZ }, opts));
const fFull = fmt({ weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fDay = fmt({ weekday: 'short', day: 'numeric' });
const fTime = fmt({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const msg = document.getElementById('msg');

fetch('/api/chart?token=' + encodeURIComponent(TOKEN))
  .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
  .then(draw)
  .catch((e) => { msg.textContent = 'Could not load chart data: ' + e.message; });

function draw(d) {
  if (!window.LightweightCharts) { msg.textContent = 'Could not load the chart library.'; return; }
  if (!d.bars.length) { msg.textContent = 'No 1h bars stored yet. Press "Reload history" on the status page.'; return; }
  msg.remove();
  const bars = d.bars;
  const times = bars.map((b) => b.time);
  const el = document.getElementById('chart');
  const chart = LightweightCharts.createChart(el, {
    autoSize: true,
    layout: { background: { color: '#ffffff' }, textColor: '#1d2330' },
    grid: { vertLines: { color: '#f1f3f6' }, horzLines: { color: '#f1f3f6' } },
    crosshair: { mode: 0 },
    timeScale: {
      timeVisible: true, secondsVisible: false, rightOffset: 6,
      tickMarkFormatter: (t, type) => (type <= 2 ? fDay.format(new Date(t * 1000)) : fTime.format(new Date(t * 1000))),
    },
    localization: { timeFormatter: (t) => fFull.format(new Date(t * 1000)) },
  });
  const series = chart.addCandlestickSeries({
    upColor: '#0a7d55', downColor: '#c0392b', borderVisible: false, wickUpColor: '#0a7d55', wickDownColor: '#c0392b',
  });
  series.setData(bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })));
  chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - 120), to: bars.length + 4 });

  // bar index for a time (fractional inside a bar, extrapolated past the ends)
  function logical(t) {
    let lo = 0, hi = times.length - 1;
    if (t < times[0]) return (t - times[0]) / 3600;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (times[mid] <= t) lo = mid; else hi = mid - 1; }
    const next = times[lo + 1];
    const span = next ? Math.min(3600, next - times[lo]) : 3600;
    return lo + Math.min(next ? 1 : Infinity, (t - times[lo]) / span);
  }
  const barTime = (t) => times[Math.max(0, Math.floor(logical(t)))];
  const X = (t) => chart.timeScale().logicalToCoordinate(logical(t));
  const Y = (p) => series.priceToCoordinate(p);

  const ui = { dead: document.getElementById('dead'), paper: document.getElementById('paper'), bias: document.getElementById('bias') };

  function setMarkers() {
    const m = [];
    if (ui.bias.checked) for (const b of d.bias) m.push({
      time: barTime(b.time), position: 'aboveBar', shape: 'circle', size: 0.6,
      color: b.to === 'bullish' ? '#0a7d55' : b.to === 'bearish' ? '#c0392b' : '#8a93a5',
      text: b.to === 'bullish' ? 'bull' : b.to === 'bearish' ? 'bear' : 'neutral',
    });
    const trades = (list, real) => {
      for (const t of list) {
        const buy = t.side === 'buy';
        const col = real ? '#2457c5' : buy ? '#0a7d55' : '#c0392b';
        m.push({ time: barTime(t.entryTime ?? t.openedAt), position: buy ? 'belowBar' : 'aboveBar', shape: buy ? 'arrowUp' : 'arrowDown', color: col, text: (real ? 'REAL ' : '') + (buy ? 'B' : 'S') });
        const exitT = t.exitTime ?? t.closedAt;
        const pts = t.points;
        if (exitT) m.push({ time: barTime(exitT), position: buy ? 'aboveBar' : 'belowBar', shape: 'square', size: 0.6, color: col, text: pts == null ? '?' : (pts >= 0 ? '+' : '') + pts.toFixed(0) });
      }
    };
    if (ui.paper.checked) trades(d.paperTrades, false);
    trades(d.liveTrades, true);
    if (d.live) m.push({ time: barTime(d.live.openedAt), position: d.live.side === 'buy' ? 'belowBar' : 'aboveBar', shape: d.live.side === 'buy' ? 'arrowUp' : 'arrowDown', color: '#2457c5', text: 'REAL open' });
    m.sort((a, b) => a.time - b.time);
    series.setMarkers(m);
  }
  setMarkers();
  for (const k of ['dead', 'paper', 'bias']) ui[k].addEventListener('change', () => { setMarkers(); schedule(); });

  const canvas = document.getElementById('overlay');
  const ctx = canvas.getContext('2d');
  const lastBarEnd = times[times.length - 1] + 3600;

  function paint() {
    const dpr = window.devicePixelRatio || 1;
    const w = el.clientWidth, h = el.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const plotW = w - chart.priceScale('right').width();
    const plotH = h - chart.timeScale().height();
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, plotW, plotH); ctx.clip();

    // Monday levels: from Monday's close to the next week
    for (let i = 0; i < d.mondays.length; i++) {
      const mo = d.mondays[i];
      const end = Math.min(mo.from + 5 * 86400, d.mondays[i + 1] ? d.mondays[i + 1].from - 86400 : Infinity);
      const x1 = X(mo.from), x2 = end === Infinity || end > lastBarEnd ? plotW : X(end);
      if (x1 == null || x2 == null || x2 < 0 || x1 > plotW) continue;
      for (const [p, dash, label] of [[mo.high, [], 'Mon H'], [mo.low, [], 'Mon L'], [mo.mid, [5, 4], 'Mon mid']]) {
        const y = Y(p); if (y == null || y < 0 || y > plotH) continue;
        ctx.strokeStyle = '#e67e22'; ctx.lineWidth = dash.length ? 1 : 1.5; ctx.setLineDash(dash);
        ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
        ctx.setLineDash([]); ctx.fillStyle = '#e67e22'; ctx.font = '11px system-ui'; ctx.fillText(label, Math.max(x1, 2) + 3, y - 3);
      }
    }

    // zones
    for (const z of d.zones) {
      const ended = z.diedAt || z.expiredAt;
      const dead = !z.alive || !!ended;
      if (dead && !z.traded && !ui.dead.checked) continue;
      const x1 = X(z.startTime);
      const end = ended || null;
      const x2 = end == null || end >= lastBarEnd ? plotW : X(end);
      if (x1 == null || x2 == null || x2 < 0 || x1 > plotW) continue;
      const buy = z.side === 'buy';
      const yo1 = Y(z.origHigh), yo2 = Y(z.origLow), y1 = Y(z.high), y2 = Y(z.low);
      if (yo1 == null || yo2 == null) continue;
      // original size: faint outline
      ctx.strokeStyle = dead ? 'rgba(120,130,145,.35)' : buy ? 'rgba(10,125,85,.35)' : 'rgba(192,57,43,.35)';
      ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.strokeRect(x1, yo1, Math.max(2, x2 - x1), yo2 - yo1);
      ctx.setLineDash([]);
      // unfilled part: filled box (order blocks get a solid edge)
      if (y1 != null && y2 != null) {
        ctx.fillStyle = dead ? 'rgba(120,130,145,.16)' : buy ? 'rgba(10,125,85,.22)' : 'rgba(192,57,43,.20)';
        ctx.fillRect(x1, y1, Math.max(2, x2 - x1), y2 - y1);
        if (z.kind === 'block' && !dead) {
          ctx.strokeStyle = buy ? '#0a7d55' : '#c0392b'; ctx.lineWidth = 1.2;
          ctx.strokeRect(x1, y1, Math.max(2, x2 - x1), y2 - y1);
        }
        if (z.traded) { ctx.strokeStyle = '#2457c5'; ctx.lineWidth = 2; ctx.strokeRect(x1, y1, Math.max(2, x2 - x1), y2 - y1); }
      }
      if (!dead && z.score != null) {
        const tooWide = d.rules.maxZoneWidth > 0 && z.high - z.low > d.rules.maxZoneWidth;
        ctx.fillStyle = buy ? '#0a7d55' : '#c0392b'; ctx.font = 'bold 11px system-ui';
        const label = (buy ? 'buy ' : 'sell ') + (z.kind === 'block' ? 'block ' : 'gap ') + z.score + (tooWide ? ' (too wide)' : '');
        ctx.fillText(label, Math.min(Math.max(x1, 2), plotW - 90) + 3, (y1 ?? yo1) - 3);
      }
    }
    ctx.restore();
  }

  // redraw the overlay whenever the chart moves (scroll, zoom, resize, price-scale drag)
  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    const run = () => { pending = false; paint(); };
    if (window.requestAnimationFrame) requestAnimationFrame(run); else setTimeout(run, 16);
    setTimeout(() => { if (pending) run(); }, 50); // in case animation frames are paused
  }
  chart.timeScale().subscribeVisibleLogicalRangeChange(schedule);
  chart.timeScale().subscribeSizeChange(schedule);
  chart.subscribeCrosshairMove(schedule);
  for (const ev of ['pointermove', 'pointerup', 'wheel', 'touchmove', 'touchend']) el.addEventListener(ev, schedule, { passive: true });
  window.addEventListener('resize', schedule);
  setTimeout(paint, 0);
  setTimeout(paint, 300);
}
</script>
<noscript>This page needs JavaScript.</noscript>
<p style="padding:0 14px;color:#8a93a5;font-size:12px">${esc('Charts by TradingView Lightweight Charts (open source).')}</p>
</body></html>`;
}
