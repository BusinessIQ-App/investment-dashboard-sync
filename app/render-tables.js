// HTML table rendering for the /positions-table and /transactions-table endpoints.
//
// Pure presentation: these take the JSON objects produced by portfolio.js
// (getPositions / getFullPicture) and return a self-contained HTML page (inline
// CSS + a tiny vanilla sort script, no external assets) for viewing in a browser.

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

// Numeric <td>. opts: { money, pct, color, dp } — color adds a +sign and pos/neg class.
function numCell(value, opts = {}) {
  if (value == null || value === '' || Number.isNaN(Number(value))) {
    return '<td class="num muted">—</td>';
  }

  const v = Number(value);
  const { money = false, pct = false, color = false, dp = 2 } = opts;

  let text;
  if (money) {
    text = '$' + v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  } else if (pct) {
    text = v.toFixed(dp) + '%';
  } else {
    text = v.toLocaleString('en-US', { maximumFractionDigits: 6 });
  }

  let cls = 'num';
  if (color) {
    cls += v > 0 ? ' pos' : v < 0 ? ' neg' : '';
    if (v > 0) text = '+' + text;
  }

  return `<td class="${cls}" data-sort="${v}">${esc(text)}</td>`;
}

function textCell(value) {
  const shown = value == null || value === '' ? '—' : value;
  return `<td data-sort="${esc(value)}">${esc(shown)}</td>`;
}

function money(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function pageShell(title, generatedAt, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 1.5rem; background: #0f1115; color: #e6e8eb; }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
  .meta { color: #8b929c; font-size: .8rem; margin-bottom: 1rem; }
  nav a { color: #5aa9ff; text-decoration: none; margin-right: 1rem; font-size: .85rem; }
  nav { margin-bottom: 1rem; }
  .cards { display: flex; flex-wrap: wrap; gap: .75rem; margin-bottom: 1.25rem; }
  .card { background: #1a1d24; border: 1px solid #262b35; border-radius: 8px; padding: .6rem .9rem; min-width: 140px; }
  .card .label { color: #8b929c; font-size: .7rem; text-transform: uppercase; letter-spacing: .04em; }
  .card .value { font-size: 1.1rem; font-variant-numeric: tabular-nums; margin-top: .15rem; }
  h2 { font-size: 1rem; margin: 1.5rem 0 .5rem; }
  table { border-collapse: collapse; width: 100%; font-size: .82rem; background: #14171d; border-radius: 8px; overflow: hidden; }
  thead th { position: sticky; top: 0; background: #1f242d; text-align: left; padding: .5rem .6rem; cursor: pointer; user-select: none; white-space: nowrap; border-bottom: 2px solid #2c333f; }
  thead th:hover { background: #262d38; }
  thead th[data-dir="asc"]::after { content: " ▲"; color: #5aa9ff; }
  thead th[data-dir="desc"]::after { content: " ▼"; color: #5aa9ff; }
  td { padding: .4rem .6rem; border-bottom: 1px solid #20252e; white-space: nowrap; }
  tbody tr:nth-child(even) { background: #171b22; }
  tbody tr:hover { background: #1e242d; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .pos { color: #4ad17a; }
  .neg { color: #ff6b6b; }
  .muted { color: #6b727c; }
  .lots { color: #8b929c; font-size: .72rem; white-space: normal; max-width: 320px; }
  .flag { font-size: .68rem; padding: .05rem .35rem; border-radius: 4px; }
  .flag.no { background: #3a2326; color: #ff9b9b; }
  .flag.yes { background: #1f2f24; color: #7ee0a3; }
  caption { caption-side: bottom; color: #6b727c; font-size: .72rem; padding-top: .5rem; text-align: left; }
</style>
</head>
<body>
<h1>${esc(title)}</h1>
<div class="meta">Generated ${esc(generatedAt)} · live from SnapTrade</div>
<nav>
  <a href="/positions-table">Positions</a>
  <a href="/transactions-table">Transactions</a>
  <a href="/positions">positions.json</a>
  <a href="/transactions">transactions.json</a>
</nav>
${bodyHtml}
<script>
document.querySelectorAll('table.sortable').forEach(table => {
  const heads = table.querySelectorAll('thead th');
  heads.forEach((th, idx) => th.addEventListener('click', () => {
    const tbody = table.tBodies[0];
    const rows = Array.from(tbody.rows);
    const dir = th.getAttribute('data-dir') === 'asc' ? 'desc' : 'asc';
    heads.forEach(h => h.removeAttribute('data-dir'));
    th.setAttribute('data-dir', dir);
    rows.sort((a, b) => {
      const av = a.cells[idx].getAttribute('data-sort') ?? a.cells[idx].textContent;
      const bv = b.cells[idx].getAttribute('data-sort') ?? b.cells[idx].textContent;
      const an = parseFloat(av), bn = parseFloat(bv);
      const c = (!isNaN(an) && !isNaN(bn)) ? an - bn : String(av).localeCompare(String(bv));
      return dir === 'asc' ? c : -c;
    });
    rows.forEach(r => tbody.appendChild(r));
  }));
});
</script>
</body>
</html>`;
}

function card(label, value, cls = '') {
  return `<div class="card"><div class="label">${esc(label)}</div><div class="value ${cls}">${esc(value)}</div></div>`;
}

function holdingsTable(holdings, { withDates = false } = {}) {
  const dateHead = withDates ? '<th>First buy</th>' : '';

  const rows = holdings.map(h => {
    const pct = h.openPnl != null && h.costBasis ? (h.openPnl / h.costBasis) * 100 : null;
    return `<tr>
      ${textCell(h.account)}
      ${textCell(h.ticker)}
      ${numCell(h.shares, { dp: 4 })}
      ${numCell(h.avgPurchasePrice, { money: true })}
      ${numCell(h.costBasis, { money: true })}
      ${numCell(h.currentPrice, { money: true })}
      ${numCell(h.marketValue, { money: true })}
      ${numCell(h.openPnl, { money: true, color: true })}
      ${numCell(pct, { pct: true, color: true })}
      ${withDates ? textCell(h.firstBuyDate) : ''}
    </tr>`;
  }).join('\n');

  return `<table class="sortable">
  <thead><tr>
    <th>Account</th><th>Ticker</th><th class="num">Shares</th>
    <th class="num">Avg cost</th><th class="num">Cost basis</th><th class="num">Price</th>
    <th class="num">Market value</th><th class="num">Open P/L</th><th class="num">Open P/L %</th>${dateHead}
  </tr></thead>
  <tbody>
${rows}
  </tbody>
  <caption>Click any column header to sort. Amounts in USD.</caption>
</table>`;
}

function renderPositionsTable(data) {
  const holdings = data.holdings || [];
  const totalMv = holdings.reduce((s, h) => s + (h.marketValue || 0), 0);
  const totalCost = holdings.reduce((s, h) => s + (h.costBasis || 0), 0);
  const totalPnl = holdings.reduce((s, h) => s + (h.openPnl || 0), 0);

  const cards = `<div class="cards">
    ${card('Holdings', String(holdings.length))}
    ${card('Market value', money(totalMv))}
    ${card('Cost basis', money(totalCost))}
    ${card('Unrealized P/L', money(totalPnl), totalPnl >= 0 ? 'pos' : 'neg')}
  </div>`;

  return pageShell('Positions', data.generatedAt, cards + holdingsTable(holdings, { withDates: true }));
}

function lotsSummary(lots) {
  if (!lots || !lots.length) return '<span class="muted">—</span>';
  return lots
    .map(l => `${l.shares}@$${l.price}${l.buyDate ? ' (' + esc(l.buyDate) + ')' : ''}`)
    .join('; ');
}

function realizedTable(sells) {
  const rows = sells.map(s => {
    const pct = s.realizedGain != null && s.costBasis ? (s.realizedGain / s.costBasis) * 100 : null;
    const flag = s.costBasisComplete
      ? '<td><span class="flag yes">full</span></td>'
      : '<td><span class="flag no">partial</span></td>';
    return `<tr>
      ${textCell(s.account)}
      ${textCell(s.ticker)}
      ${textCell(s.sellDate)}
      ${numCell(s.shares, { dp: 4 })}
      ${numCell(s.sellPrice, { money: true })}
      ${numCell(s.proceeds, { money: true })}
      ${numCell(s.costBasis, { money: true })}
      ${numCell(s.realizedGain, { money: true, color: true })}
      ${numCell(pct, { pct: true, color: true })}
      ${flag}
      <td class="lots">${lotsSummary(s.matchedLots)}</td>
    </tr>`;
  }).join('\n');

  return `<table class="sortable">
  <thead><tr>
    <th>Account</th><th>Ticker</th><th>Sell date</th><th class="num">Shares</th>
    <th class="num">Sell price</th><th class="num">Proceeds</th><th class="num">Cost basis</th>
    <th class="num">Realized gain</th><th class="num">Gain %</th><th>Basis</th><th>Matched lots</th>
  </tr></thead>
  <tbody>
${rows}
  </tbody>
  <caption>"partial" = matching buys predate the available history, so realized gain is unknown. Amounts in USD.</caption>
</table>`;
}

function renderTransactionsTable(data) {
  const holdings = data.holdings || [];
  const sells = data.realizedSells || [];

  const complete = sells.filter(s => s.costBasisComplete);
  const incomplete = sells.filter(s => !s.costBasisComplete);
  const netRealized = complete.reduce((s, x) => s + (x.realizedGain || 0), 0);
  const incompleteProceeds = incomplete.reduce((s, x) => s + (x.proceeds || 0), 0);
  const totalMv = holdings.reduce((s, h) => s + (h.marketValue || 0), 0);
  const totalPnl = holdings.reduce((s, h) => s + (h.openPnl || 0), 0);

  const cards = `<div class="cards">
    ${card('Holdings', String(holdings.length))}
    ${card('Market value', money(totalMv))}
    ${card('Unrealized P/L', money(totalPnl), totalPnl >= 0 ? 'pos' : 'neg')}
    ${card('Realized P/L (full basis)', money(netRealized), netRealized >= 0 ? 'pos' : 'neg')}
    ${card('Sells', String(sells.length))}
    ${card('Partial-basis sells', `${incomplete.length} · ${money(incompleteProceeds)}`)}
  </div>`;

  const errorBanner = data.activitiesError
    ? `<div class="meta neg">Activity feed error: ${esc(data.activitiesError)}</div>`
    : '';

  const body =
    cards +
    errorBanner +
    '<h2>Current holdings</h2>' +
    holdingsTable(holdings, { withDates: true }) +
    '<h2>Realized sells</h2>' +
    realizedTable(sells);

  return pageShell('Transactions', data.generatedAt, body);
}

module.exports = { renderPositionsTable, renderTransactionsTable };
