// Live SnapTrade portfolio reads for the HTTP service.
//
// These functions pull directly from the SnapTrade API and return plain JSON —
// they do NOT touch PostgreSQL and are independent of the sync schedule. Used by
// the /positions and /transactions endpoints in sync-service.js.
//
// Two views:
//   getPositions()    -> current holdings only (one positions call per account).
//   getFullPicture()  -> current holdings annotated with buy dates, plus a FIFO-
//                        reconstructed list of realized sells (gain/loss).
//
// SnapTrade field notes (from the SDK's AccountPosition / AccountUniversalActivity
// models — these bit us once, so they're documented here):
//   - getAllAccountPositions returns AccountPosition, whose `units`, `price`, and
//     `cost_basis` are STRINGS. `cost_basis` is the book price / average purchase
//     price PER SHARE (per-contract for options) — NOT a total. Total cost basis is
//     cost_basis * units. AccountPosition has no open_pnl, so we derive it.
//   - Per-lot purchase dates live in `tax_lots` (original_purchase_date), but tax
//     lots are a paid-plan feature and are usually absent. When missing, buy dates
//     for the /transactions view fall back to the earliest BUY in the activity feed.
//   - The account-agnostic transactionsAndReporting.getActivities endpoint returns
//     HTTP 410 Gone for users created after 2026-04-25. We use the per-account,
//     paginated accountInformation.getAccountActivities instead.

const { Snaptrade } = require('snaptrade-typescript-sdk');

function createClient() {
  return new Snaptrade({
    clientId: process.env.SNAPTRADE_CLIENT_ID,
    consumerKey: process.env.SNAPTRADE_CONSUMER_KEY
  });
}

function snaptradeCreds() {
  return {
    userId: process.env.SNAPTRADE_USER_ID,
    userSecret: process.env.SNAPTRADE_USER_SECRET
  };
}

// SnapTrade returns several numeric fields as strings; coerce safely.
function parseNum(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, places = 2) {
  if (value == null || Number.isNaN(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// SnapTrade dates arrive as ISO timestamps (midnight ET); trim to the calendar date.
function dateOnly(value) {
  return value ? String(value).slice(0, 10) : null;
}

// Works for both position and activity objects (shapes differ by endpoint).
function getTicker(item) {
  return (
    item.instrument?.symbol ||
    item.instrument?.raw_symbol ||
    item.symbol?.symbol ||
    item.symbol?.raw_symbol ||
    (typeof item.symbol === 'string' ? item.symbol : null) ||
    null
  );
}

function getShares(position) {
  const n = parseNum(position.units ?? position.quantity ?? position.open_quantity);
  return n == null ? 0 : n;
}

// Parse position.tax_lots (paid-plan only; usually absent). Returns [] when missing.
function parseTaxLots(position) {
  const lots = Array.isArray(position.tax_lots) ? position.tax_lots : [];

  return lots
    .map(lot => ({
      purchaseDate: lot.original_purchase_date || null,
      shares: parseNum(lot.quantity),
      purchasePrice: parseNum(lot.purchased_price),
      costBasis: parseNum(lot.cost_basis)
    }))
    .filter(lot => lot.shares != null || lot.costBasis != null || lot.purchaseDate);
}

function shapeLot(lot) {
  return {
    purchaseDate: dateOnly(lot.purchaseDate),
    shares: round(lot.shares, 6),
    purchasePrice: round(lot.purchasePrice),
    costBasis: round(lot.costBasis)
  };
}

// Fetch every account and its current positions, shaped for output.
// Returns { accounts: [{ id, name }], holdings: [...], cashTickers: Set }.
// cashTickers collects money-market / cash-equivalent symbols so the activity feed
// can drop their cash-sweep "sells" (which aren't meaningful realized gains).
async function loadAccountsAndPositions(snaptrade) {
  const creds = snaptradeCreds();

  const accountsResponse = await snaptrade.accountInformation.listUserAccounts(creds);
  const accounts = accountsResponse.data || [];

  const holdings = [];
  const cashTickers = new Set();

  for (const account of accounts) {
    const accountName = account.name || account.id;

    const positionsResponse = await snaptrade.accountInformation.getAllAccountPositions({
      ...creds,
      accountId: account.id
    });

    const positions = positionsResponse.data?.results || [];

    for (const position of positions) {
      const ticker = getTicker(position);
      const shares = getShares(position);

      if (!ticker || !shares) continue;

      if (position.cash_equivalent) cashTickers.add(ticker);

      // cost_basis is the per-share book price; total = per-share * shares.
      const avgPurchasePrice = parseNum(position.cost_basis);
      const currentPrice = parseNum(position.price);

      const taxLots = parseTaxLots(position);

      let costBasis = null;
      if (taxLots.length) {
        const summed = taxLots.reduce((sum, lot) => {
          if (lot.costBasis != null) return sum + lot.costBasis;
          if (lot.shares != null && lot.purchasePrice != null) {
            return sum + lot.shares * lot.purchasePrice;
          }
          return sum;
        }, 0);
        costBasis = summed || (avgPurchasePrice != null ? avgPurchasePrice * shares : null);
      } else if (avgPurchasePrice != null) {
        costBasis = avgPurchasePrice * shares;
      }

      const marketValue = currentPrice != null ? shares * currentPrice : null;
      const openPnl =
        marketValue != null && costBasis != null ? marketValue - costBasis : null;

      const datedLots = taxLots
        .filter(lot => lot.purchaseDate)
        .map(lot => lot.purchaseDate)
        .sort();

      holdings.push({
        accountId: account.id,
        account: accountName,
        ticker,
        shares: round(shares, 6),
        avgPurchasePrice: round(avgPurchasePrice),
        costBasis: round(costBasis),
        currentPrice: round(currentPrice),
        marketValue: round(marketValue),
        openPnl: round(openPnl),
        firstBuyDate: datedLots.length ? dateOnly(datedLots[0]) : null,
        purchaseLots: taxLots.map(shapeLot)
      });
    }
  }

  const accountSummaries = accounts.map(a => ({ id: a.id, name: a.name || a.id }));

  return { accounts: accountSummaries, holdings, cashTickers };
}

// Public: current holdings only.
async function getPositions() {
  const snaptrade = createClient();
  const { accounts, holdings } = await loadAccountsAndPositions(snaptrade);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    source: 'snaptrade_positions',
    note:
      'avgPurchasePrice is SnapTrade\'s per-share book price; costBasis is the total ' +
      '(per-share * shares); openPnl is marketValue - costBasis. purchaseLots/firstBuyDate ' +
      'are populated only when the brokerage exposes tax lots (a paid-plan feature).',
    accounts,
    holdings
  };
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// Pull one account's full activity feed, paging through the cursor. SnapTrade caps
// each page at 1000 and reports the running total in pagination.
async function loadAccountActivities(snaptrade, accountId) {
  const creds = snaptradeCreds();
  const limit = 1000;
  let offset = 0;
  const all = [];

  // Hard iteration cap as a runaway guard (10000 transactions / page of 1000).
  for (let page = 0; page < 100; page++) {
    const response = await snaptrade.accountInformation.getAccountActivities({
      ...creds,
      accountId,
      startDate: '2000-01-01',
      endDate: todayIso(),
      offset,
      limit
    });

    const payload = response.data || {};
    const batch = Array.isArray(payload.data) ? payload.data : [];

    for (const activity of batch) {
      all.push({ ...activity, _accountId: accountId });
    }

    offset += batch.length;
    const total = payload.pagination?.total;

    if (batch.length === 0) break;
    if (batch.length < limit) break;
    if (total != null && offset >= total) break;
  }

  return all;
}

async function loadAllActivities(snaptrade, accounts) {
  const all = [];
  for (const account of accounts) {
    const activities = await loadAccountActivities(snaptrade, account.id);
    all.push(...activities);
  }
  return all;
}

function normalizeActivityType(activity) {
  return String(activity.type || activity.action || '').trim().toUpperCase();
}

function activityAccountId(activity) {
  return (
    activity._accountId ||
    activity.account?.id ||
    activity.account_id ||
    activity.account ||
    null
  );
}

// FIFO-match SELL activities against BUY history per (account, ticker).
// Returns { realizedSells: [...], openLotsByKey: Map<"acct|ticker", [lots]> }, where
// openLots are the buys still held (used as a buy-date fallback for current holdings).
function reconstructLots(activities, cashTickers = new Set()) {
  const groups = new Map();

  for (const activity of activities) {
    const type = normalizeActivityType(activity);
    if (type !== 'BUY' && type !== 'SELL') continue;

    const ticker = getTicker(activity);
    const accountId = activityAccountId(activity);
    if (!ticker || accountId == null) continue;

    // Skip money-market / cash-equivalent sweeps — not meaningful realized gains.
    if (cashTickers.has(ticker)) continue;

    const key = `${accountId}|${ticker}`;
    if (!groups.has(key)) groups.set(key, []);

    groups.get(key).push({
      type,
      ticker,
      accountId,
      date: activity.trade_date || activity.settlement_date || null,
      shares: Math.abs(parseNum(activity.units) ?? 0),
      price: parseNum(activity.price)
    });
  }

  const realizedSells = [];
  const openLotsByKey = new Map();

  for (const [key, events] of groups) {
    // Chronological; on ties process buys before sells so a same-day buy can cover
    // a same-day sell.
    events.sort((a, b) => {
      const da = a.date || '';
      const db = b.date || '';
      if (da < db) return -1;
      if (da > db) return 1;
      if (a.type === b.type) return 0;
      return a.type === 'BUY' ? -1 : 1;
    });

    const lots = []; // FIFO queue of { date, shares, price }

    for (const event of events) {
      if (event.type === 'BUY') {
        if (event.shares > 0) {
          lots.push({ date: event.date, shares: event.shares, price: event.price });
        }
        continue;
      }

      // SELL: consume lots from the front.
      let remaining = event.shares;
      const matchedLots = [];
      let matchedCost = 0;
      let costComplete = true;

      while (remaining > 0 && lots.length > 0) {
        const lot = lots[0];
        const take = Math.min(remaining, lot.shares);

        matchedLots.push({ buyDate: dateOnly(lot.date), shares: round(take, 6), price: round(lot.price) });
        if (lot.price != null) {
          matchedCost += take * lot.price;
        } else {
          costComplete = false;
        }

        lot.shares -= take;
        remaining -= take;
        if (lot.shares <= 1e-9) lots.shift();
      }

      // Sold more than the buy history accounts for (window gap / transfer-in).
      if (remaining > 1e-9) costComplete = false;

      const sellPrice = event.price;
      const proceeds = sellPrice != null ? event.shares * sellPrice : null;
      const costBasis = costComplete ? matchedCost : null;
      const realizedGain =
        proceeds != null && costBasis != null ? proceeds - costBasis : null;

      realizedSells.push({
        accountId: event.accountId,
        ticker: event.ticker,
        sellDate: dateOnly(event.date),
        shares: round(event.shares, 6),
        sellPrice: round(sellPrice),
        proceeds: round(proceeds),
        costBasis: round(costBasis),
        realizedGain: round(realizedGain),
        costBasisComplete: costComplete,
        matchedLots
      });
    }

    openLotsByKey.set(
      key,
      lots
        .filter(lot => lot.shares > 1e-9)
        .map(lot => ({ buyDate: dateOnly(lot.date), shares: round(lot.shares, 6), price: round(lot.price) }))
    );
  }

  return { realizedSells, openLotsByKey };
}

// Public: holdings + buy dates + FIFO realized sells.
async function getFullPicture() {
  const snaptrade = createClient();

  const { accounts, holdings, cashTickers } = await loadAccountsAndPositions(snaptrade);

  let realizedSells = [];
  let openLotsByKey = new Map();
  let activitiesError = null;

  try {
    const activities = await loadAllActivities(snaptrade, accounts);
    ({ realizedSells, openLotsByKey } = reconstructLots(activities, cashTickers));
  } catch (err) {
    // Positions still succeed even if the brokerage doesn't expose activities.
    activitiesError = err.message || String(err);
  }

  // Fill buy dates/lots from the activity feed for holdings that lacked tax lots.
  const annotatedHoldings = holdings.map(holding => {
    if (holding.firstBuyDate || holding.purchaseLots.length) return holding;

    const openLots = openLotsByKey.get(`${holding.accountId}|${holding.ticker}`) || [];
    if (!openLots.length) return holding;

    return {
      ...holding,
      firstBuyDate: openLots[0].buyDate || null,
      purchaseLots: openLots.map(lot => ({
        purchaseDate: lot.buyDate,
        shares: lot.shares,
        purchasePrice: lot.price,
        costBasis:
          lot.shares != null && lot.price != null ? round(lot.shares * lot.price) : null
      }))
    };
  });

  const accountNameById = new Map(accounts.map(a => [a.id, a.name]));
  const sells = realizedSells.map(sell => ({
    account: accountNameById.get(sell.accountId) || sell.accountId,
    ...sell
  }));

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    source: 'snaptrade_positions_and_activities',
    note:
      'Holdings cost basis comes from SnapTrade positions (avgPurchasePrice is the ' +
      'per-share book price; costBasis is the total). Buy dates use tax lots when ' +
      'available, otherwise the earliest BUY in the activity feed. realizedSells is a ' +
      'best-effort FIFO reconstruction from the activity feed; entries with ' +
      'costBasisComplete=false had matching buys outside the available history.',
    activitiesError,
    accounts,
    holdings: annotatedHoldings,
    realizedSells: sells
  };
}

module.exports = { getPositions, getFullPicture };
