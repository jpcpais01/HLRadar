// HL Radar dashboard (vanilla JS, no build step).
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json' } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---------- formatting ----------
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const usd = (x, d = 0) => (!isNum(x) ? '–' : (x < 0 ? '-' : '') + '$' + compact(Math.abs(x), d));
function compact(x, d = 0) {
  if (x >= 1e9) return (x / 1e9).toFixed(2) + 'B';
  if (x >= 1e6) return (x / 1e6).toFixed(2) + 'M';
  if (x >= 1e4) return (x / 1e3).toFixed(1) + 'k';
  return x.toLocaleString(undefined, { maximumFractionDigits: d });
}
const pct = (x, d = 1) => (!isNum(x) ? '–' : (x * 100).toFixed(d) + '%');
const f2 = (x, d = 2) => (!isNum(x) ? '–' : x.toFixed(d));
const sgn = (x) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');
const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');
const ago = (t) => {
  if (!t) return '–';
  const s = (Date.now() - t) / 1000;
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const hold = (h) => (!isNum(h) ? '–' : h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`);
const sideChip = (s) => (s > 0 ? '<span class="chip long">LONG</span>' : '<span class="chip short">SHORT</span>');
const coinName = (c) => esc(c.includes(':') ? `${c.split(':')[1]}` : c) + (c.includes(':') ? ` <span class="muted">${esc(c.split(':')[0])}</span>` : '');

let META = null;
let CONFIG = null;
const CLASS_COLORS = { index: '#4aa3ff', equity: '#6c8cff', commodity: '#d8a24a', fx: '#8bd0c9', major: '#f7931a', largecap: '#9b7bff', alt: '#7d8ea3', smallcap: '#5b6676', meme: '#ff5fa2' };

// ---------- generic sortable table ----------
function table(el, rows, cols, { onClick, sortKey, desc = true, empty = 'Nothing here yet.' } = {}) {
  if (!rows.length) { el.innerHTML = `<div class="empty">${empty}</div>`; return; }
  let key = sortKey, d = desc;
  const render = () => {
    const col = cols.find((c) => c.key === key);
    const sorted = col ? [...rows].sort((a, b) => {
      const va = col.sort ? col.sort(a) : a[key], vb = col.sort ? col.sort(b) : b[key];
      return (d ? -1 : 1) * ((va ?? -Infinity) > (vb ?? -Infinity) ? 1 : (va ?? -Infinity) < (vb ?? -Infinity) ? -1 : 0);
    }) : rows;
    el.innerHTML = `<div class="tablewrap"><table><thead><tr>${cols.map((c) => `<th class="${c.l ? 'l' : ''}" data-k="${c.key}" title="${esc(c.tip || '')}">${c.label}${c.key === key ? (d ? ' ▾' : ' ▴') : ''}</th>`).join('')}</tr></thead>
      <tbody>${sorted.map((r, i) => `<tr class="${onClick ? 'click' : ''}" data-i="${rows.indexOf(r)}">${cols.map((c) => `<td class="${c.l ? 'l' : ''} ${c.cls ? c.cls(r) : ''}">${c.fmt ? c.fmt(r, i) : esc(r[c.key])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    el.querySelectorAll('th').forEach((th) => th.onclick = () => { if (key === th.dataset.k) d = !d; else { key = th.dataset.k; d = true; } render(); });
    if (onClick) el.querySelectorAll('tbody tr').forEach((tr) => tr.onclick = () => onClick(rows[tr.dataset.i]));
  };
  render();
}

// ---------- tiny SVG charts ----------
function lineChart(series, { w = 900, h = 220, fmtY = (v) => v.toFixed(2), baseline = null } = {}) {
  const all = series.flatMap((s) => s.pts);
  if (all.length < 2) return '<div class="empty">Not enough data</div>';
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (baseline !== null) { y0 = Math.min(y0, baseline); y1 = Math.max(y1, baseline); }
  if (y1 === y0) y1 = y0 + 1;
  const pad = { l: 56, r: 10, t: 10, b: 22 };
  const X = (x) => pad.l + ((x - x0) / Math.max(1, x1 - x0)) * (w - pad.l - pad.r);
  const Y = (y) => pad.t + (1 - (y - y0) / (y1 - y0)) * (h - pad.t - pad.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => y0 + t * (y1 - y0));
  const dates = [0, 0.5, 1].map((t) => x0 + t * (x1 - x0));
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="none" style="max-height:${h}px">
    ${ticks.map((v) => `<line x1="${pad.l}" x2="${w - pad.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="#243040" stroke-width="1"/><text x="${pad.l - 6}" y="${Y(v) + 4}" text-anchor="end">${fmtY(v)}</text>`).join('')}
    ${baseline !== null ? `<line x1="${pad.l}" x2="${w - pad.r}" y1="${Y(baseline)}" y2="${Y(baseline)}" stroke="#8496a9" stroke-dasharray="3 3"/>` : ''}
    ${dates.map((t, i) => `<text x="${X(t)}" y="${h - 4}" text-anchor="${['start', 'middle', 'end'][i]}">${new Date(t).toISOString().slice(0, 10)}</text>`).join('')}
    ${series.map((s) => `<polyline fill="none" stroke="${s.color}" stroke-width="${s.width || 2}" points="${s.pts.map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ')}"/>`).join('')}
  </svg>`;
}

function barChart(items, { w = 900, h = 160, fmt = (v) => pct(v, 0) } = {}) {
  if (!items.length) return '<div class="empty">No data</div>';
  const max = Math.max(...items.map((i) => Math.abs(i.v)), 1e-9);
  const pad = { t: 14, b: 20 };
  const mid = pad.t + (h - pad.t - pad.b) / 2;
  const bw = (w - 20) / items.length;
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" style="max-height:${h}px">
    <line x1="0" x2="${w}" y1="${mid}" y2="${mid}" stroke="#243040"/>
    ${items.map((it, i) => {
      const bh = (Math.abs(it.v) / max) * ((h - pad.t - pad.b) / 2);
      const x = 10 + i * bw + bw * 0.15;
      const y = it.v >= 0 ? mid - bh : mid;
      return `<rect x="${x}" y="${y}" width="${bw * 0.7}" height="${Math.max(1, bh)}" rx="2" fill="${it.v >= 0 ? '#2fbf71' : '#ef5a5a'}"><title>${esc(it.label)}: ${fmt(it.v)}</title></rect>
        <text x="${x + bw * 0.35}" y="${h - 4}" text-anchor="middle">${esc(it.label)}</text>
        <text x="${x + bw * 0.35}" y="${it.v >= 0 ? y - 3 : y + bh + 11}" text-anchor="middle">${fmt(it.v)}</text>`;
    }).join('')}
  </svg>`;
}

function mixBar(mix) {
  const parts = Object.entries(mix || {}).sort((a, b) => b[1] - a[1]);
  let left = 0;
  const title = parts.map(([k, v]) => `${META?.classes[k]?.label || k}: ${pct(v, 0)}`).join('\n');
  return `<div class="bar" title="${esc(title)}" style="min-width:110px">${parts.map(([k, v]) => { const s = `<i style="left:${left * 100}%;width:${v * 100}%;background:${CLASS_COLORS[k] || '#666'}"></i>`; left += v; return s; }).join('')}</div>`;
}
const legend = () => Object.entries(META.classes).map(([k, c]) => `<span class="chip"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${CLASS_COLORS[k]};margin-right:5px"></span>${esc(c.label)}</span>`).join('');

// ---------- status bar ----------
async function refreshStatus() {
  const s = await api('/api/status');
  const p = s.progress;
  const scanning = s.running ? `<b>${esc(p.phase)}</b> ${p.done}/${p.total}` : `${esc(p.phase === 'idle' ? 'Idle' : p.phase)}`;
  $('#status').innerHTML = `
    <span>${scanning}</span>
    <span>${s.analysed} wallets analysed</span>
    <span title="Wallets we implicitly compared; used to deflate Sharpe ratios">N trials ${compact(s.nTrials)}</span>
    <span>positions ${ago(s.liveUpdatedAt)}</span>
    ${s.running ? '<button class="btn" id="stop">Stop scan</button>' : '<button class="btn primary" id="scan">Run scan</button>'}
    <button class="btn" id="live">Refresh positions</button>`;
  $('#scan')?.addEventListener('click', async () => { await api('/api/scan/start', { method: 'POST', body: '{}' }); refreshStatus(); });
  $('#stop')?.addEventListener('click', async () => { await api('/api/scan/stop', { method: 'POST' }); refreshStatus(); });
  $('#live').onclick = async (e) => { e.target.disabled = true; e.target.textContent = 'Refreshing…'; await api('/api/live/refresh', { method: 'POST' }); loadAll(); refreshStatus(); };
  return s;
}

// ---------- Signals ----------
async function renderSignals() {
  const el = $('#tab-signals');
  const c = await api('/api/consensus');
  const strong = c.rows.filter((r) => r.label === 'strong').length;
  el.innerHTML = `
    <div class="grid cols-4">
      <div class="card kpi"><div class="v">${c.nWallets}</div><div class="l">finalist wallets (${c.nEntities} independent traders)</div></div>
      <div class="card kpi"><div class="v">${c.rows.length}</div><div class="l">assets they hold right now</div></div>
      <div class="card kpi"><div class="v">${strong}</div><div class="l">strong consensus signals</div></div>
      <div class="card kpi"><div class="v">${c.alerts.length}</div><div class="l">clustered entries (last 48h)</div></div>
    </div>
    <h2>Clustered entries</h2>
    <p class="sub">Two or more independent finalists opening the same asset in the same direction inside the recent window. This is the closest thing to a "go" signal here.</p>
    <div id="alerts" class="grid cols-2"></div>
    <h2>Consensus by asset</h2>
    <p class="sub">Every asset at least one finalist holds. <b>Bias</b> is skill-weighted agreement among holders. <b>Breadth</b> is the share of all finalist skill-weight in the asset. <b>Size</b> is the median position as a multiple of the holder's equity. <b>Signal</b> combines agreement, breadth, freshness and size, and needs at least 2 independent holders on one side. Click a row for the holders.</p>
    <div id="cons" class="card"></div>
    <div id="holders"></div>`;
  $('#alerts').innerHTML = c.alerts.length ? c.alerts.map((a) => `
    <div class="card alert"><div style="display:flex;justify-content:space-between"><b>${coinName(a.coin)} ${sideChip(a.side)}</b><span class="muted">${ago(a.last)}</span></div>
    <div>${a.entities} independent finalists opened ${usd(a.notional)} total</div>
    <div class="muted" style="font-size:12px">${a.events.map((e) => `${short(e.address)} ${usd(e.notional)} @ ${f2(e.avgPx, 4)}`).join(' · ')}</div></div>`).join('')
    : '<div class="empty">No clustered entries in the current window.</div>';
  table($('#cons'), c.rows, [
    { key: 'coin', label: 'Asset', l: true, fmt: (r) => `<b>${coinName(r.coin)}</b>`, sort: (r) => r.coin },
    { key: 'cls', label: 'Class', l: true, fmt: (r) => `<span class="chip">${esc(META.classes[r.cls]?.label || r.cls)}</span>` },
    { key: 'bias', label: 'Bias', fmt: (r) => r.bias === 'LONG' ? '<span class="chip long">LONG</span>' : r.bias === 'SHORT' ? '<span class="chip short">SHORT</span>' : '<span class="chip">MIXED</span>', sort: (r) => r.direction },
    { key: 'direction', label: 'Agreement × breadth', fmt: (r) => { const v = r.direction * Math.sqrt(r.breadth); const w = Math.abs(v) * 50; return `<div class="diverge" title="agreement ${pct(r.direction, 0)}, breadth ${pct(r.breadth, 0)}"><i style="${v >= 0 ? `left:50%;width:${w}%;background:var(--long)` : `left:${50 - w}%;width:${w}%;background:var(--short)`}"></i></div>`; }, sort: (r) => r.direction * Math.sqrt(r.breadth) },
    { key: 'nLong', label: 'L / S', fmt: (r) => `<span class="pos">${r.nLong}</span> / <span class="neg">${r.nShort}</span>`, sort: (r) => r.nLong + r.nShort },
    { key: 'longNotional', label: 'Long $', fmt: (r) => usd(r.longNotional) },
    { key: 'shortNotional', label: 'Short $', fmt: (r) => usd(r.shortNotional) },
    { key: 'conviction', label: 'Size', fmt: (r) => `${f2(r.conviction, 2)}x`, tip: 'median position notional / holder equity' },
    { key: 'freshShare', label: 'Fresh', fmt: (r) => pct(r.freshShare, 0), tip: 'share of holder weight that opened in the last 48h' },
    { key: 'uPnl', label: 'Open PnL', fmt: (r) => usd(r.uPnl), cls: (r) => sgn(r.uPnl) },
    { key: 'change24h', label: '24h', fmt: (r) => pct(r.change24h), cls: (r) => sgn(r.change24h) },
    { key: 'funding', label: 'Funding/h', fmt: (r) => isNum(r.funding) ? (r.funding * 100).toFixed(4) + '%' : '–' },
    { key: 'strength', label: 'Signal', fmt: (r) => `<div style="display:flex;gap:6px;align-items:center;justify-content:flex-end"><div class="bar" style="min-width:60px"><i style="left:0;width:${Math.min(100, r.strength)}%;background:var(--accent)"></i></div><span class="chip ${r.label}">${Math.round(r.strength)}</span></div>` },
  ], { sortKey: 'strength', empty: 'No finalist positions loaded yet. Run a scan, then refresh positions.', onClick: (r) => {
    $('#holders').innerHTML = `<h2>${coinName(r.coin)} holders</h2><div class="card" id="htab"></div>`;
    table($('#htab'), r.holders, [
      { key: 'entity', label: 'Trader', l: true, fmt: (h) => h.wallets.map((w) => `<a href="#" data-w="${w}" class="mono">${short(w)}</a>`).join(', ') },
      { key: 'side', label: 'Side', fmt: (h) => sideChip(h.side) },
      { key: 'notional', label: 'Notional', fmt: (h) => usd(h.notional) },
      { key: 'exposure', label: 'x Equity', fmt: (h) => `${f2(h.exposure)}x` },
      { key: 'uPnl', label: 'Open PnL', fmt: (h) => usd(h.uPnl), cls: (h) => sgn(h.uPnl) },
      { key: 'opened', label: 'Opened', fmt: (h) => ago(h.opened) },
      { key: 'weight', label: 'Skill', fmt: (h) => Math.round(h.weight * 100) },
    ], { sortKey: 'notional' });
    $('#holders').querySelectorAll('[data-w]').forEach((a) => a.onclick = (e) => { e.preventDefault(); openWallet(a.dataset.w); });
    $('#holders').scrollIntoView({ behavior: 'smooth' });
  } });
}

// ---------- Finalists ----------
const walletCols = (withFailed) => [
  { key: 'rank', label: '#', fmt: (r, i) => i + 1, sort: (r) => -r.score },
  { key: 'address', label: 'Wallet', l: true, fmt: (r) => `<span class="mono">${short(r.address)}</span> ${r.name ? `<span class="muted">${esc(r.name)}</span>` : ''} ${r.source === 'vault' ? '<span class="chip">vault</span>' : ''}${r.entity !== r.address ? '<span class="chip" title="linked by funding to another scanned wallet">linked</span>' : ''}` },
  ...(withFailed ? [{ key: 'failed', label: 'Failed gates', l: true, fmt: (r) => r.failed.length ? r.failed.map((f) => `<span class="chip short">${esc(META.gates[f]?.label || f)}</span>`).join('') : '<span class="chip long">finalist-grade</span>', sort: (r) => -r.failed.length }] : []),
  { key: 'score', label: 'Skill', fmt: (r) => `<b>${f2(r.score, 0)}</b>` },
  { key: 'accountValue', label: 'Equity', fmt: (r) => usd(r.accountValue) },
  { key: 'totalPnl', label: 'Realized PnL', fmt: (r) => usd(r.totalPnl), cls: (r) => sgn(r.totalPnl) },
  { key: 'totalReturn', label: 'Return', fmt: (r) => pct(r.totalReturn, 0), cls: (r) => sgn(r.totalReturn) },
  { key: 'annSharpe', label: 'Sharpe', fmt: (r) => f2(r.annSharpe) },
  { key: 'dsr', label: 'DSR', fmt: (r) => f2(Math.max(r.dsr, r.tradeDsr)), sort: (r) => Math.max(r.dsr, r.tradeDsr), tip: 'Deflated Sharpe (best of daily / per-trade): probability the edge is real after correcting for how many wallets were screened' },
  { key: 'maxDrawdown', label: 'Max DD', fmt: (r) => pct(r.maxDrawdown, 0) },
  { key: 'positiveMonthShare', label: '+Months', fmt: (r) => pct(r.positiveMonthShare, 0) },
  { key: 'nTrades', label: 'Trades', fmt: (r) => r.nTrades },
  { key: 'winRate', label: 'Win', fmt: (r) => pct(r.winRate, 0) },
  { key: 'profitFactor', label: 'PF', fmt: (r) => f2(r.profitFactor) },
  { key: 'medianHoldHours', label: 'Hold', fmt: (r) => hold(r.medianHoldHours) },
  { key: 'medianLeverage', label: 'Lev', fmt: (r) => `${f2(r.medianLeverage, 1)}x` },
  { key: 'slCoverage', label: 'Stops', fmt: (r) => pct(r.slCoverage, 0) },
  { key: 'assetMix', label: 'Asset mix', fmt: (r) => mixBar(r.assetMix), sort: (r) => r.tradfiShare },
];

async function renderFinalists(rank) {
  const el = $('#tab-finalists');
  const max = Math.max(...rank.funnel.map((f) => f.remaining), 1);
  let lastLayer = null;
  const nearMiss = rank.rows.filter((r) => r.failed.length === 1);
  el.innerHTML = `
    <div class="grid cols-2">
      <div class="card funnel"><h3 style="margin-top:0">Filter funnel</h3>${rank.funnel.map((f) => {
        const head = f.layer !== lastLayer ? `<div class="layer">${esc(f.layer)}</div>` : '';
        lastLayer = f.layer;
        return `${head}<div class="row"><span>${esc(f.label)}</span><div class="fb" style="width:${Math.max(0.4, (Math.log10(1 + f.remaining) / Math.log10(1 + max)) * 100)}%"></div><span class="mono" style="text-align:right">${f.remaining.toLocaleString()}</span></div>`;
      }).join('')}<p class="muted" style="font-size:12px">Bar lengths are log-scaled. Gates apply in order; every gate is explained in the Filters tab.</p></div>
      <div class="card"><h3 style="margin-top:0">Finalists</h3>
        <p class="sub" style="margin:0">Wallets that pass every enabled gate, ranked by skill score (top ${CONFIG.finalists.count}). These drive the Signals and Trade feed tabs.</p>
        <div class="grid cols-4" style="margin-top:12px">
          <div class="kpi"><div class="v">${rank.finalists.length}</div><div class="l">finalists</div></div>
          <div class="kpi"><div class="v">${usd(rank.finalists.reduce((s, r) => s + (r.accountValue || 0), 0))}</div><div class="l">combined equity</div></div>
          <div class="kpi"><div class="v">${nearMiss.length}</div><div class="l">near misses (fail 1 gate)</div></div>
        </div>
        <div style="margin-top:12px">${legend()}</div>
      </div>
    </div>
    <h2>Finalists</h2><div class="card" id="fin"></div>
    <h2>Near misses</h2><p class="sub">Failed exactly one gate. Worth a manual look, or a sign a threshold is too strict.</p><div class="card" id="near"></div>`;
  table($('#fin'), rank.finalists, walletCols(false), { sortKey: 'score', onClick: (r) => openWallet(r.address), empty: 'No finalists yet. Run a scan, or loosen a gate in the Filters tab.' });
  table($('#near'), nearMiss, walletCols(true), { sortKey: 'score', onClick: (r) => openWallet(r.address) });
}

async function renderWallets(rank) {
  const el = $('#tab-wallets');
  el.innerHTML = `<p class="sub">Every deep-scanned wallet and the gates it failed. Paste any address to analyse it too.</p>
    <div style="display:flex;gap:8px;margin-bottom:12px"><input id="addr" placeholder="0x… wallet address" style="flex:1;max-width:460px;background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font:inherit"/><button class="btn primary" id="add">Analyse wallet</button><span id="addmsg" class="muted"></span></div>
    <div class="card" id="all"></div>`;
  table($('#all'), rank.rows, walletCols(true), { sortKey: 'score', onClick: (r) => openWallet(r.address) });
  $('#add').onclick = async () => {
    const a = $('#addr').value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) { $('#addmsg').textContent = 'Not a valid address'; return; }
    $('#addmsg').textContent = 'Analysing (can take a minute)…';
    try { await api(`/api/wallet/${a}/scan`, { method: 'POST' }); $('#addmsg').textContent = ''; await loadAll(); openWallet(a.toLowerCase()); }
    catch (e) { $('#addmsg').textContent = e.message; }
  };
}

// ---------- Trade feed ----------
async function renderFeed() {
  const el = $('#tab-feed');
  const c = await api('/api/consensus');
  el.innerHTML = `<p class="sub">Finalists' fills from the last ${CONFIG.signals.freshHours}h, grouped into trades. Big = at least ${usd(CONFIG.signals.bigTradeUsd)} or ${pct(CONFIG.signals.bigTradeEquityPct, 0)} of the wallet's equity.</p>
    <label class="muted"><input type="checkbox" id="bigonly" checked/> big trades only</label><div class="card" id="feedt" style="margin-top:10px"></div>`;
  const draw = () => {
    const rows = $('#bigonly').checked ? c.events.filter((e) => e.big) : c.events;
    table($('#feedt'), rows, [
      { key: 'time', label: 'When', l: true, fmt: (e) => `${ago(e.time)} <span class="muted">${new Date(e.time).toLocaleString()}</span>` },
      { key: 'address', label: 'Wallet', l: true, fmt: (e) => `<span class="mono">${short(e.address)}</span>` },
      { key: 'coin', label: 'Asset', l: true, fmt: (e) => `<b>${coinName(e.coin)}</b>` },
      { key: 'kind', label: 'Action', fmt: (e) => `${e.kind === 'open' ? (e.flip ? 'Flip to' : 'Open') : 'Close'} ${sideChip(e.side)}` },
      { key: 'notional', label: 'Notional', fmt: (e) => usd(e.notional) },
      { key: 'equityPct', label: '% equity', fmt: (e) => pct(e.equityPct, 0) },
      { key: 'avgPx', label: 'Avg px', fmt: (e) => f2(e.avgPx, 4) },
      { key: 'pnl', label: 'Realized', fmt: (e) => (e.kind === 'close' ? usd(e.pnl) : ''), cls: (e) => sgn(e.pnl) },
      { key: 'score', label: 'Skill', fmt: (e) => f2(e.score, 0) },
    ], { sortKey: 'time', onClick: (e) => openWallet(e.address), empty: 'No trades in the window (or positions not refreshed yet).' });
  };
  $('#bigonly').onchange = draw;
  draw();
}

// ---------- Filters / methodology ----------
async function renderFilters() {
  const el = $('#tab-filters');
  const g = CONFIG.gates;
  const layers = {};
  for (const [id, info] of Object.entries(META.gates)) (layers[info.layer] ||= []).push([id, info]);
  const labels = { minTrades: 'min trades', minActiveDays: 'min active days', minDays: 'min days', maxDaysSinceLastTrade: 'max days since last trade', minMedianHoldHours: 'min median hold (h)', maxMedianHoldHours: 'max median hold (h)', maxTradesPerDay: 'max trades/day', minVolume: 'min volume $', minMedianTradeNotional: 'min median trade $', maxMemeShare: 'max meme share (0-1)', minStopCoverage: 'min stop coverage (0-1)', minSaneStopShare: 'min sane-stop share (0-1)', minEvaluatedTrades: 'min trades with order history', worstTradeFloor: 'worst trade floor (-0.15 = -15%)', minCounterpartyValue: 'min counterparty value $', minDeflatedSharpe: 'min deflated Sharpe (0-1)', minPsr: 'min PSR vs 0 (0-1)', minPositiveMonthShare: 'min positive months (0-1)', minPositiveWeekShare: 'min positive weeks (0-1)', maxDrawdown: 'max drawdown (0-1)', maxTopTradeShare: 'max best-trade share (0-1)', minProfitFactor: 'min profit factor', maxP90Leverage: 'max p90 leverage', maxCurrentLeverage: 'max current leverage', maxLiquidations: 'max liquidations', minOpenPnlPct: 'min open PnL (-0.25 = -25%)' };
  el.innerHTML = `
    <div class="method">
      <h2>How the filters work</h2>
      <p>With ~50k wallets on the leaderboard, hundreds will have great-looking records by pure chance, the same way some coin-flippers throw 10 heads in a row. So no single metric is trusted. Wallets go through three layers of gates, and only wallets passing all of them become finalists. Survivors are then ranked by a skill score. Full write-up: <code>docs/FILTERS.md</code>.</p>
      <ol>
        <li><b>Universe (cheap, every leaderboard wallet).</b> Account ≥ ${usd(CONFIG.universe.minAccountValue)}, all-time volume ≥ ${usd(CONFIG.universe.minAllTimeVolume)}, profitable all-time and this month, monthly turnover ≤ ${CONFIG.universe.maxMonthlyTurnover}x equity (above that is market making). The best ${CONFIG.universe.deepScanCount} plus up to 30 profitable vaults get a deep scan.</li>
        <li><b>Data & style.</b> Enough trades, long enough history, still active, intraday to few-day holding period, serious volume.</li>
        <li><b>Your filters.</b> Asset class (memes penalised, TradFi rewarded), stop-loss usage with sane distances, and optionally whale-sized funding wallets.</li>
        <li><b>Skill vs luck.</b> Deflated Sharpe Ratio (corrects for the ${compact(CONFIG.nTrialsOverride || 0) === '0' ? 'number of wallets screened' : CONFIG.nTrialsOverride + ' trials'}), month-by-month consistency plus a first-half/second-half out-of-sample check, drawdown, profit not from one trade, healthy win/payoff, sane leverage, and no hidden open losses.</li>
      </ol>
      <p><b>Skill score</b> (ranks survivors, 0-100): ${Object.entries(META.weights).map(([k, w]) => `${k} ${Math.round(w * 100)}%`).join(' · ')}.</p>
      <p><b>Independent traders.</b> Wallets that send money to each other, or share a funding wallet with up to 3 other scanned wallets, are treated as one trader in the consensus so one person with 4 accounts can't fake a consensus.</p>
    </div>
    <h2>Tune the gates</h2>
    <p class="sub">Changes re-rank instantly from cached data. Universe and scan settings apply on the next scan.</p>
    <div class="cfg" id="cfg">${Object.entries(layers).map(([layer, gates]) => `<div class="card"><h3 style="margin-top:0">${esc(layer)}</h3>${gates.map(([id, info]) => `
      <div style="margin-bottom:10px"><div class="gh"><span>${esc(info.label)}</span><input type="checkbox" data-g="${id}" data-k="enabled" ${g[id].enabled ? 'checked' : ''}/></div>
      <div class="muted" style="font-size:12px;margin:2px 0 4px">${esc(info.why)}</div>
      ${Object.entries(g[id]).filter(([k]) => k !== 'enabled').map(([k, v]) => `<label>${esc(labels[k] || k)} ${typeof v === 'boolean' ? `<input type="checkbox" data-g="${id}" data-k="${k}" ${v ? 'checked' : ''}/>` : `<input type="number" step="any" data-g="${id}" data-k="${k}" value="${v}"/>`}</label>`).join('')}</div>`).join('')}</div>`).join('')}
      <div class="card"><h3 style="margin-top:0">Universe & finalists</h3>
        ${Object.entries(CONFIG.universe).map(([k, v]) => `<label>${esc(k)} ${typeof v === 'boolean' ? `<input type="checkbox" data-s="universe" data-k="${k}" ${v ? 'checked' : ''}/>` : `<input type="number" step="any" data-s="universe" data-k="${k}" value="${v}"/>`}</label>`).join('')}
        <label>finalists count <input type="number" data-s="finalists" data-k="count" value="${CONFIG.finalists.count}"/></label>
        <label>N trials override (0 = auto) <input type="number" data-s="root" data-k="nTrialsOverride" value="${CONFIG.nTrialsOverride}"/></label>
        ${Object.entries(CONFIG.signals).map(([k, v]) => `<label>${esc(k)} <input type="number" step="any" data-s="signals" data-k="${k}" value="${v}"/></label>`).join('')}
        ${Object.entries(CONFIG.scan).map(([k, v]) => `<label>${esc(k)} <input type="number" step="any" data-s="scan" data-k="${k}" value="${v}"/></label>`).join('')}
      </div>
    </div>
    <div style="margin-top:12px;display:flex;gap:8px"><button class="btn primary" id="save">Save & re-rank</button><button class="btn" id="reset">Reset to defaults</button><span id="savemsg" class="muted"></span></div>`;
  $('#save').onclick = async () => {
    const over = { gates: {}, universe: {}, finalists: {}, signals: {}, scan: {} };
    el.querySelectorAll('[data-g]').forEach((i) => { (over.gates[i.dataset.g] ||= {})[i.dataset.k] = i.type === 'checkbox' ? i.checked : Number(i.value); });
    el.querySelectorAll('[data-s]').forEach((i) => { const v = i.type === 'checkbox' ? i.checked : Number(i.value); if (i.dataset.s === 'root') over[i.dataset.k] = v; else over[i.dataset.s][i.dataset.k] = v; });
    CONFIG = await api('/api/config', { method: 'POST', body: JSON.stringify(over) });
    $('#savemsg').textContent = 'Saved.';
    loadAll();
  };
  $('#reset').onclick = async () => { CONFIG = await api('/api/config/reset', { method: 'POST' }); renderFilters(); loadAll(); };
}

// ---------- Wallet drawer ----------
async function openWallet(addr) {
  const d = $('#drawer');
  d.classList.remove('hidden');
  const body = $('#drawer-body');
  body.innerHTML = '<div class="muted">Loading…</div>';
  let w;
  try { w = await api(`/api/wallet/${addr}`); } catch (e) { body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const m = w.metrics;
  const comp = w.components;
  body.innerHTML = `
    <h2 style="margin-right:40px"><span class="mono">${esc(m.address)}</span> ${w.meta?.displayName ? `<span class="muted">${esc(w.meta.displayName)}</span>` : ''}</h2>
    <div class="muted" style="margin:-6px 0 12px">Rank #${w.rank} · ${w.failed.length ? `fails ${w.failed.length} gate(s)` : '<span class="pos">passes all gates</span>'} ·
      <a href="https://app.hyperliquid.xyz/explorer/address/${m.address}" target="_blank" rel="noopener">HL explorer</a> ·
      <a href="https://hypurrscan.io/address/${m.address}" target="_blank" rel="noopener">Hypurrscan</a> · scanned ${ago(w.scannedAt)}</div>
    <div class="grid cols-4">
      <div class="card kpi"><div class="v">${f2(w.score, 0)}</div><div class="l">skill score</div></div>
      <div class="card kpi"><div class="v">${usd(m.accountValue)}</div><div class="l">equity</div></div>
      <div class="card kpi"><div class="v ${sgn(m.totalPnl)}">${usd(m.totalPnl)}</div><div class="l">realized PnL (${Math.round(m.spanDays)}d)</div></div>
      <div class="card kpi"><div class="v">${f2(m.annSharpe)}</div><div class="l">Sharpe (luck benchmark ${f2(m.luckBenchmarkAnnSharpe)})</div></div>
    </div>
    <h3>Equity index (realized, deposit-neutral) vs account value</h3>
    <div class="card">${lineChart([{ pts: w.series.days.map((t, i) => [t, w.series.curve[i]]), color: '#4aa3ff' }], { fmtY: (v) => pct(v - 1, 0), baseline: 1 })}
      ${lineChart([{ pts: w.series.accountValue, color: '#8496a9', width: 1.5 }], { h: 120, fmtY: (v) => usd(v) })}</div>
    <h3>Monthly returns</h3><div class="card">${barChart(w.series.monthly.map((x) => ({ label: x.month.slice(2), v: x.ret })))}</div>
    <div class="grid cols-2">
      <div><h3>Gates</h3><div class="card">${w.gates.map((g) => `<div class="gate"><span class="${!g.enabled ? 'off' : g.pass ? 'ok' : 'bad'}">${!g.enabled ? '○' : g.pass ? '✓' : '✗'}</span><div><b>${esc(g.label)}</b> <span class="muted" style="font-size:11px">${esc(g.layer)}</span><div class="d">${esc(g.detail)}${g.note ? ` · <span class="warn">${esc(g.note)}</span>` : ''}</div></div></div>`).join('')}</div></div>
      <div><h3>Skill score parts</h3><div class="card">${Object.entries(comp).map(([k, v]) => `<div style="display:grid;grid-template-columns:120px 1fr 40px;gap:8px;align-items:center;padding:3px 0"><span class="muted">${esc(k)}</span><div class="bar"><i style="left:0;width:${v * 100}%;background:var(--accent)"></i></div><span class="mono">${Math.round(v * 100)}</span></div>`).join('')}
        <p class="muted" style="font-size:12px">Weights: ${Object.entries(META.weights).map(([k, x]) => `${k} ${Math.round(x * 100)}%`).join(', ')}</p></div>
        <h3>Asset mix (by volume)</h3><div class="card">${Object.entries(m.assetMix).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div style="display:grid;grid-template-columns:130px 1fr 50px;gap:8px;align-items:center;padding:2px 0"><span class="muted">${esc(META.classes[k]?.label || k)}</span><div class="bar"><i style="left:0;width:${v * 100}%;background:${CLASS_COLORS[k]}"></i></div><span class="mono">${pct(v, 0)}</span></div>`).join('')}
        <div style="margin-top:8px">${m.topCoins.map((c) => `<span class="chip">${coinName(c.coin)} ${pct(c.share, 0)} <span class="${sgn(c.pnl)}">${usd(c.pnl)}</span></span>`).join(' ')}</div></div>
      </div>
    </div>
    <h3>Key stats</h3>
    <div class="card"><div class="grid cols-4">${[
      ['Trades', m.nTrades], ['Active days', m.activeDays], ['Median hold', hold(m.medianHoldHours)], ['Trades/day', f2(m.tradesPerDay, 1)],
      ['Win rate', pct(m.winRate)], ['Payoff ratio', f2(m.payoffRatio)], ['Profit factor', f2(m.profitFactor)], ['Expectancy/trade', pct(m.expectancyPct, 2)],
      ['Sortino', f2(m.annSortino)], ['PSR (vs 0)', f2(m.psr)], ['DSR daily', f2(m.dsr)], ['DSR per-trade', f2(m.tradeDsr)],
      ['Max drawdown', pct(m.maxDrawdown)], ['+ Months', `${pct(m.positiveMonthShare, 0)} of ${m.nMonths}`], ['Sharpe 1st / 2nd half', `${f2(m.sharpeFirstHalf)} / ${f2(m.sharpeSecondHalf)}`], ['Best trade share', pct(m.topTradeShare)],
      ['Median leverage', `${f2(m.medianLeverage, 1)}x`], ['p90 leverage', `${f2(m.p90Leverage, 1)}x`], ['Current leverage', `${f2(m.currentLeverage, 1)}x`], ['Liquidations', m.liquidations],
      ['Stops used', `${pct(m.tpsl.slCoverage, 0)} of ${m.tpsl.evaluated}`], ['Median stop dist', pct(m.tpsl.medianStopPct, 2)], ['Take-profits', pct(m.tpsl.tpCoverage, 0)], ['Median R:R', f2(m.tpsl.medianRR)],
      ['Volume', usd(m.volume)], ['Maker share', pct(m.makerShare, 0)], ['Worst trade', pct(m.worstTradePct)], ['Open PnL', pct(m.openPnlPct)],
    ].map(([l, v]) => `<div class="kpi"><div class="l">${l}</div><div style="font-weight:600">${v}</div></div>`).join('')}</div></div>
    <h3>Open positions</h3><div class="card" id="dpos"></div>
    <h3>Funding & flows</h3><div class="card">
      <div class="grid cols-4">
        <div class="kpi"><div class="l">Bridge deposits</div><div>${usd(m.flows.bridgeIn)}</div></div>
        <div class="kpi"><div class="l">Bridge withdrawals</div><div>${usd(m.flows.bridgeOut)}</div></div>
        <div class="kpi"><div class="l">Transfers in / out</div><div>${usd(m.flows.transfersIn)} / ${usd(m.flows.transfersOut)}</div></div>
        <div class="kpi"><div class="l">Pro signals</div><div>${m.pro?.isVault ? 'vault · ' : ''}${m.pro?.subAccounts || 0} sub-accounts · ${m.pro?.apiAgents || 0} API agents</div></div>
      </div>
      <div id="dcp" style="margin-top:10px"></div></div>
    <h3>Recent trades</h3><div class="card" id="dtr"></div>`;
  table($('#dpos'), w.live || [], [
    { key: 'coin', label: 'Asset', l: true, fmt: (p) => `<b>${coinName(p.coin)}</b>` },
    { key: 'side', label: 'Side', fmt: (p) => sideChip(p.side) },
    { key: 'notional', label: 'Notional', fmt: (p) => usd(p.notional) },
    { key: 'entryPx', label: 'Entry', fmt: (p) => f2(p.entryPx, 4) },
    { key: 'markPx', label: 'Mark', fmt: (p) => f2(p.markPx, 4) },
    { key: 'uPnl', label: 'Open PnL', fmt: (p) => usd(p.uPnl), cls: (p) => sgn(p.uPnl) },
    { key: 'leverage', label: 'Lev', fmt: (p) => `${p.leverage}x ${esc(p.leverageType || '')}` },
    { key: 'liqPx', label: 'Liq px', fmt: (p) => f2(p.liqPx, 4) },
  ], { sortKey: 'notional', empty: 'No open positions.' });
  table($('#dcp'), m.flows.counterparties || [], [
    { key: 'address', label: 'Counterparty', l: true, fmt: (c) => `<span class="mono">${esc(c.address)}</span>` },
    { key: 'inUsd', label: 'Sent to wallet', fmt: (c) => usd(c.inUsd) },
    { key: 'outUsd', label: 'Received from wallet', fmt: (c) => usd(c.outUsd) },
    { key: 'value', label: 'Their HL balance', fmt: (c) => (c.value === undefined ? '<span class="muted">not checked</span>' : usd(c.value)) },
  ], { sortKey: 'inUsd', empty: 'No on-Hyperliquid transfers; funds came via the bridge.' });
  table($('#dtr'), [...w.trades].reverse(), [
    { key: 'openTime', label: 'Opened', l: true, fmt: (t) => new Date(t.openTime).toLocaleString() },
    { key: 'coin', label: 'Asset', l: true, fmt: (t) => `<b>${coinName(t.coin)}</b>` },
    { key: 'side', label: 'Side', fmt: (t) => sideChip(t.side) },
    { key: 'holdMs', label: 'Held', fmt: (t) => (t.isOpen ? '<span class="warn">open</span>' : hold((t.closeTime - t.openTime) / 3600e3)), sort: (t) => (t.closeTime || Date.now()) - t.openTime },
    { key: 'maxNotional', label: 'Max size', fmt: (t) => usd(t.maxNotional) },
    { key: 'leverage', label: 'x Equity', fmt: (t) => `${f2(t.leverage, 1)}x` },
    { key: 'entryPx', label: 'Entry', fmt: (t) => f2(t.entryPx, 4) },
    { key: 'exitPx', label: 'Exit', fmt: (t) => f2(t.exitPx, 4) },
    { key: 'netPnl', label: 'Net PnL', fmt: (t) => `${usd(t.netPnl)}${t.liquidated ? ' <span class="chip short">liq</span>' : ''}`, cls: (t) => sgn(t.netPnl) },
    { key: 'retPct', label: '% equity', fmt: (t) => pct(t.retPct, 2), cls: (t) => sgn(t.retPct) },
  ], { sortKey: 'openTime' });
}
$('#drawer-close').onclick = () => $('#drawer').classList.add('hidden');
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#drawer').classList.add('hidden'); });

// ---------- tabs & boot ----------
let activeTab = location.hash.slice(1) || 'signals';
function showTab(t) {
  activeTab = t;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.id === `tab-${t}`));
  history.replaceState(null, '', `#${t}`);
}
document.querySelectorAll('#tabs button').forEach((b) => b.onclick = () => { showTab(b.dataset.tab); if (b.dataset.tab === 'filters') renderFilters(); });

async function loadAll() {
  const rank = await api('/api/ranking');
  await Promise.all([renderSignals(), renderFinalists(rank), renderWallets(rank), renderFeed()]);
}

(async function boot() {
  [META, CONFIG] = await Promise.all([api('/api/meta'), api('/api/config')]);
  showTab(activeTab);
  await refreshStatus();
  await loadAll();
  renderFilters();
  let wasRunning = false;
  setInterval(async () => {
    const s = await refreshStatus().catch(() => null);
    if (!s) return;
    // While scanning, refresh the tables every so often so finalists appear as they're found.
    if (s.running && s.progress.done % 5 === 0) loadAll();
    if (wasRunning && !s.running) loadAll();
    wasRunning = s.running;
  }, 5000);
  setInterval(() => { if (!document.hidden) loadAll(); }, 120000);
})();
