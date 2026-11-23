/** Small server-rendered pages for the agent: status and market finder. */
import type { Runner } from './runner';

type Status = ReturnType<Runner['status']>;
type Markets = Awaited<ReturnType<Runner['findMarkets']>>;

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const f1 = (n: number | null | undefined) => (n == null ? '-' : n.toFixed(1));
const fmt = (t: number | null | undefined) =>
  t == null
    ? '-'
    : new Date(t * 1000).toLocaleString('en-GB', { timeZone: 'Europe/Oslo', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

const STYLE = `
  body{font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f6f7f9;color:#1d2330}
  main{max-width:1100px;margin:0 auto;padding:20px}
  h1{font-size:20px;margin:0 0 4px} h2{font-size:15px;margin:24px 0 8px;color:#4a5263;text-transform:uppercase;letter-spacing:.04em}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
  .card{background:#fff;border:1px solid #e3e6ec;border-radius:8px;padding:10px 12px}
  .card b{display:block;font-size:12px;color:#6b7385;font-weight:500} .card span{font-size:17px;font-weight:600}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e3e6ec;border-radius:8px;overflow:hidden}
  th,td{padding:6px 8px;border-bottom:1px solid #eef0f3;text-align:left;white-space:nowrap} th{background:#fafbfc;font-weight:600;font-size:12px;color:#4a5263}
  .buy{color:#0a7d55} .sell{color:#c0392b} .warn{color:#b7791f} .error{color:#c0392b} .muted{color:#8a93a5}
  .pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;background:#eef0f3}
  .on{background:#d8f3e6;color:#0a7d55} .off{background:#fde2e0;color:#c0392b}
  form{display:inline} button{font:inherit;padding:6px 12px;border-radius:6px;border:1px solid #c9ced8;background:#fff;cursor:pointer}
  input[type=text]{font:inherit;padding:6px 8px;border:1px solid #c9ced8;border-radius:6px;width:260px}
  pre{background:#fff;border:1px solid #e3e6ec;border-radius:8px;padding:10px;overflow:auto;font-size:12px;max-height:300px}
  .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0}
`;

function page(title: string, body: string, refresh = false) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? '<meta http-equiv="refresh" content="60">' : ''}<title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

function action(path: string, label: string, token: string) {
  return `<form method="post" action="${path}?token=${encodeURIComponent(token)}"><button>${esc(label)}</button></form>`;
}

export function statusPage(s: Status, token: string): string {
  const t = encodeURIComponent(token);
  const sum = s.summary;
  const m = s.monday;
  const cards = [
    ['Mode', `<span class="pill ${s.paused ? 'off' : 'on'}">${s.paused ? 'paused' : 'signals only'}</span>`],
    ['Price', f1(s.lastPrice)],
    ['Bias', `<span class="${s.bias === 'bullish' ? 'buy' : s.bias === 'bearish' ? 'sell' : ''}">${esc(s.bias)}</span>`],
    ['Monday H / L / mid', m?.complete ? `${f1(m.high)} / ${f1(m.low)} / ${f1(m.mid)}` : m ? 'Monday in progress' : '-'],
    ['Paper trades', `${sum.trades} (${(sum.winRate * 100).toFixed(0)}% wins)`],
    ['Paper result', `${sum.totalPoints >= 0 ? '+' : ''}${f1(sum.totalPoints)} pts`],
    ['Last run', fmt(s.lastTick)],
    ['Next run', fmt(s.nextTick)],
    [
      'IG account',
      s.account
        ? `${esc(s.account)}${s.wantedAccount && s.wantedAccount !== s.account ? ` <span class="error">(should be ${esc(s.wantedAccount)})</span>` : ''}`
        : `<span class="muted">not logged in yet${s.wantedAccount ? ` (will use ${esc(s.wantedAccount)})` : ''}</span>`,
    ],
    ['IG data allowance', s.allowance ? `${s.allowance.remainingAllowance} / ${s.allowance.totalAllowance}` : '-'],
  ]
    .map(([k, v]) => `<div class="card"><b>${k}</b><span>${v}</span></div>`)
    .join('');

  const pos = s.paper
    ? `<table><tr><th>Side</th><th>Entry</th><th>Stop</th><th>Target</th><th>Opened</th><th>Score</th><th>Trigger</th></tr>
       <tr><td class="${s.paper.side}">${s.paper.side}</td><td>${f1(s.paper.price)}</td><td>${f1(s.paper.stop)}</td><td>${f1(s.paper.target)}</td>
       <td>${fmt(s.paper.time)}</td><td>${s.paper.score} ${esc(s.paper.scoreParts.join(' '))}</td><td>${s.paper.trigger}</td></tr></table>`
    : '<p class="muted">No open paper position.</p>';

  const zones = s.zones.length
    ? `<table><tr><th>Side</th><th>Zone</th><th>Width</th><th>Score</th><th>Created</th><th>Tradeable now</th></tr>${s.zones
        .sort((a, b) => b.high - a.high)
        .map((z) => {
          const ok = z.width <= s.rules.maxZoneWidth;
          return `<tr><td class="${z.side}">${z.side}</td><td>${f1(z.low)} - ${f1(z.high)}</td><td>${f1(z.width)}</td><td>${z.score} <span class="muted">${esc(z.scoreParts.join(' '))}</span></td><td>${fmt(z.createdAt)}</td><td>${ok ? (z.score >= s.rules.minScore ? 'yes' : 'Mondays only') : '<span class="muted">too wide</span>'}</td></tr>`;
        })
        .join('')}</table>`
    : '<p class="muted">No zones within reach.</p>';

  const trades = s.trades.length
    ? `<table><tr><th>Opened</th><th>Side</th><th>Entry</th><th>Exit</th><th>Reason</th><th>Points</th><th>Score</th><th>Trigger</th></tr>${s.trades
        .map(
          (x) =>
            `<tr><td>${fmt(x.entryTime)}</td><td class="${x.side}">${x.side}</td><td>${f1(x.entry)}</td><td>${f1(x.exit)}</td><td>${x.exitReason}</td><td class="${x.points >= 0 ? 'buy' : 'sell'}">${f1(x.points)}</td><td>${x.score}</td><td>${x.trigger}</td></tr>`,
        )
        .join('')}</table>`
    : '<p class="muted">No paper trades yet.</p>';

  const log = s.log.map((l) => `<tr><td>${fmt(l.time)}</td><td class="${l.level}">${esc(l.msg)}</td></tr>`).join('');

  return page(
    'autolevels agent',
    `<h1>autolevels agent <span class="muted">· ${esc(s.priceEpic)}</span></h1>
     <div class="muted">Signals only: no orders are sent to IG. Page refreshes every minute.</div>
     <div class="row">${s.paused ? action('/api/resume', 'Resume signals', token) : action('/api/pause', 'Pause signals', token)}
       ${action('/api/warmup', 'Reload history', token)}
       ${action('/api/relogin', 'Log in to IG again', token)}
       <a href="/markets?token=${t}">Market finder</a> · <a href="/history?token=${t}">Download history</a> · <a href="/api/status?token=${t}">JSON</a></div>
     <div class="cards">${cards}</div>
     <h2>Paper position</h2>${pos}
     <h2>Zones within reach</h2>${zones}
     <h2>Paper trades</h2>${trades}
     <h2>Log</h2><table>${log || '<tr><td class="muted">Nothing yet</td></tr>'}</table>`,
    true,
  );
}

export function marketsPage(q: string, r: Markets | null, token: string, error?: string): string {
  const t = encodeURIComponent(token);
  const link = (epic: string) => `/markets?token=${t}&q=${encodeURIComponent(q)}&epic=${encodeURIComponent(epic)}#details`;
  const accounts = r
    ? `<table><tr><th>Account ID</th><th>Name</th><th>Type</th><th>Preferred</th><th>Agent</th></tr>${r.accounts
        .map((a) => `<tr><td>${esc(a.accountId)}</td><td>${esc(a.accountName)}</td><td>${esc(a.accountType)}</td><td>${a.preferred ? 'yes' : ''}</td><td>${a.accountId === r.currentAccountId ? '<b>agent is on this</b>' : ''}</td></tr>`)
        .join('')}</table>`
    : '';

  // plain CFD markets first, then barriers, then options
  const rank = (type: string) => (type.startsWith('OPT_') ? 2 : type.startsWith('KNOCKOUTS') ? 1 : 0);
  const sorted = r ? [...r.markets].sort((a, b) => rank(a.instrumentType) - rank(b.instrumentType)) : [];
  const markets = r
    ? sorted.length
      ? `<p class="muted">${sorted.length} hits. Tap an epic for its details (minimum size, stop rules).</p>
         <div style="overflow-x:auto"><table><tr><th>Epic</th><th>Name</th><th>Type</th><th>Expiry</th><th>Status</th><th>Bid / offer</th></tr>${sorted
           .map(
             (m) =>
               `<tr><td><a href="${link(m.epic)}"><b>${esc(m.epic)}</b></a></td><td>${esc(m.instrumentName)}</td><td>${esc(m.instrumentType)}</td><td>${esc(m.expiry)}</td><td>${esc(m.marketStatus)}</td><td>${f1(m.bid)} / ${f1(m.offer)}</td></tr>`,
           )
           .join('')}</table></div>`
      : '<p class="muted">No hits.</p>'
    : '';

  let details = '';
  if (r?.details) {
    const d = r.details;
    const errs = d.errors.map((e) => `<li>version ${e.version}: ${esc(e.error)}</li>`).join('');
    if (d.data) {
      const ins = d.data.instrument as Record<string, unknown>;
      const rules = d.data.dealingRules as Record<string, { value?: number; unit?: string } | string | undefined>;
      const snap = d.data.snapshot as Record<string, unknown>;
      const rule = (k: string) => {
        const v = rules?.[k];
        return v == null ? '-' : typeof v === 'string' ? v : `${v.value} ${v.unit ?? ''}`;
      };
      const rows: [string, unknown][] = [
        ['Name', ins.name],
        ['Type', ins.type],
        ['Expiry', ins.expiry],
        ['Status', snap?.marketStatus],
        ['Bid / offer', `${snap?.bid ?? '-'} / ${snap?.offer ?? '-'}`],
        ['Min size', rule('minDealSize')],
        ['Min normal stop / limit distance', rule('minNormalStopOrLimitDistance')],
        ['Min guaranteed stop distance', rule('minControlledRiskStopDistance')],
        ['Guaranteed stops allowed', ins.controlledRiskAllowed],
        ['Value of one point', `${ins.valueOfOnePip ?? '-'} ${ins.onePipMeans ?? ''}`],
        ['Contract size', ins.contractSize],
        ['Currencies', Array.isArray(ins.currencies) ? (ins.currencies as { code: string }[]).map((c) => c.code).join(', ') : '-'],
        ['Market order allowed', rules?.marketOrderPreference],
        ['API version that worked', d.version],
      ];
      details = `<h2 id="details">Details: ${esc(d.epic)}</h2>
        <table>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v ?? '-')}</td></tr>`).join('')}</table>
        ${errs ? `<p class="warn">Failed first:</p><ul>${errs}</ul>` : ''}
        <h2>Raw response (send me this)</h2><pre>${esc(JSON.stringify({ epic: d.epic, version: d.version, instrument: ins, dealingRules: rules }, null, 2))}</pre>`;
    } else {
      details = `<h2 id="details">Details: ${esc(d.epic)}</h2><p class="error">IG gave no details in any API version:</p><ul>${errs}</ul>`;
    }
  }

  return page(
    'Market finder',
    `<h1>Market finder</h1><div class="muted">Searches IG with your login. Search results depend on which IG account the agent is logged in to.</div>
     <div class="row"><form method="get" action="/markets"><input type="hidden" name="token" value="${esc(token)}"><input type="text" name="q" value="${esc(q)}" placeholder="e.g. Germany 40 Cash"> <button>Search</button></form>
     <a href="/?token=${t}">Back to status</a></div>
     ${error ? `<p class="error">${esc(error)}</p>` : ''}
     ${r ? `<p>Agent session: <b>${esc(r.currentAccountId ?? '-')}</b>${r.wantedAccountId ? ` · IG_ACCOUNT_ID: <b>${esc(r.wantedAccountId)}</b>` : ' · IG_ACCOUNT_ID not set (uses the preferred account)'}</p>
     ${details}<h2>Markets</h2>${markets}<h2>Your IG accounts</h2>${accounts}` : ''}`,
  );
}

export function historyPage(token: string, estimate?: { points: number; remaining: number | null; url: string }): string {
  const t = encodeURIComponent(token);
  return page(
    'Download history',
    `<h1>Download price history</h1>
     <p>Downloads mid-price bars from IG as CSV for the backtester (<code>npm run backtest -- --entry 3m.csv --hour 1h.csv</code>).
     Every bar costs one IG data point; the weekly allowance is 10,000 and the agent itself uses about 4,500 a week.</p>
     <form method="get" action="/api/history.csv"><input type="hidden" name="token" value="${esc(token)}">
     <div class="row">Resolution <select name="resolution"><option>MINUTE_3</option><option>HOUR</option></select>
     From <input type="text" name="from" placeholder="2026-11-01"> To <input type="text" name="to" placeholder="2026-11-20"> <button>Estimate</button></div></form>
     ${estimate ? `<p>About <b>${estimate.points}</b> data points${estimate.remaining != null ? ` (remaining this week: ${estimate.remaining})` : ''}. <a href="${esc(estimate.url)}">Download</a></p>` : ''}
     <p><a href="/?token=${t}">Back to status</a></p>`,
  );
}
