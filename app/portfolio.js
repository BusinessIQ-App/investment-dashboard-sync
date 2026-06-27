// Live SnapTrade portfolio reads for the HTTP service.
//
// These functions pull directly from the SnapTrade API and return plain JSON —
// they do NOT touch PostgreSQL and are independent of the sync schedule. Used by
// the /positions and /transactions endpoints in sync-service.js.
//
// Two views:
//   getPositions()    -> current holdings only (one positions call per account)
//   getFullPicture()  -> current holdings annotated with open-lot buy dates, plus
//                        a FIFO-reconstructed list of realized sells (gain/loss).
//
// Caveats for the full picture: SnapTrade returns whatever activity history the
// connected brokerage exposes (windows and completeness vary), and it is a flat
// BUY/SELL feed, not broker-reported lots. Realized gain is therefore a best-effort
// FIFO reconstruction; sells whose matching buys predate the available history are
// flagged costBasisComplete=false.

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

// Works for both position and activity objects (SnapTrade shapes vary by version).
function getTicker(item) {
  return (
    item.instrument?.symbol ||
    item.instrument?.raw_symbol ||
    item.symbol?.symbol ||
    item.symbol?.raw_symbol ||
    item.symbol ||
    null
  );
}

function getShares(position) {
  return Number(position.units || position.quantity || position.open_quantity || 0);
}

function getAvgPurchasePrice(position) {
  if (position.average_purchase_price != null) {
    return Number(position.average_purchase_price);
  }

  // Fall back to deriving it from a broker-reported cost basis, if present.
  const shares = getShares(position);
  if (position.cost_basis != null && shares) {
    return Number(position.cost_basis) / shares;
  }

  return null;
}

function getCostBasis(position) {
  if (position.cost_basis != null) {
    return Number(position.cost_basis);
  }

  const avg = getAvgPurchasePrice(position);
  const shares = getShares(position);
  if (avg != null && shares) {
    return avg * shares;
  }

  return null;
}

function round(value, places = 2) {
  if (value == null || Number.isNaN(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// Fetch every account and its current positions, shaped for output. Returns
// { accounts: [{ id, name }], holdings: [...] }.
async function loadAccountsAndPositions(snaptrade) {
  const creds = snaptradeCreds();

  const accountsResponse = await snaptrade.accountInformation.listUserAccounts(creds);
  const accounts = accountsResponse.data || [];

  const holdings = [];

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

      const currentPrice = position.price != null ? Number(position.price) : null;
      const marketValue = currentPrice != null ? shares * currentPrice : null;

      holdings.push({
        accountId: account.id,
        account: accountName,
        ticker,
        shares,
        avgPurchasePrice: round(getAvgPurchasePrice(position)),
        costBasis: round(getCostBasis(position)),
        currentPrice: round(currentPrice),
        marketValue: round(marketValue),
        openPnl: position.open_pnl != null ? round(Number(position.open_pnl)) : null
      });
    }
  }

  const accountSummaries = accounts.map(a => ({ id: a.id, name: a.name || a.id }));

  return { accounts: accountSummaries, holdings };
}

// Public: current holdings only.
async function getPositions() {
  const snaptrade = createClient();
  const { accounts, holdings } = await loadAccountsAndPositions(snaptrade);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    source: 'snaptrade_positions',
    accounts,
    holdings
  };
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// Pull the full activity feed across all accounts in one call. SnapTrade returns
// whatever the brokerage exposes within the date window.
async function loadActivities(snaptrade) {
  const creds = snaptradeCreds();

  const response = await snaptrade.transactionsAndReporting.getActivities({
    ...creds,
    startDate: '2000-01-01',
    endDate: todayIso()
  });

  // Defensive: the SDK has returned both a bare array and a wrapped object across
  // versions.
  const data = response.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function normalizeActivityType(activity) {
  return String(activity.type || activity.action || '').trim().toUpperCase();
}

function activityAccountId(activity) {
  return activity.account?.id || activity.account_id || activity.account || null;
}

// FIFO-match SELL activities against BUY history per (account, ticker).
// Returns { realizedSells: [...], openLotsByKey: Map<"acct|ticker", [lots]> }.
function reconstructLots(activities) {
  // Group buys/sells by account+ticker.
  const groups = new Map();

  for (const activity of activities) {
    const type = normalizeActivityType(activity);
    if (type !== 'BUY' && type !== 'SELL') continue;

    const ticker = getTicker(activity);
    const accountId = activityAccountId(activity);
    if (!ticker || accountId == null) continue;

    const key = `${accountId}|${ticker}`;
    if (!groups.has(key)) groups.set(key, []);

    groups.get(key).push({
      type,
      ticker,
      accountId,
      date: activity.trade_date || activity.settlement_date || null,
      shares: Math.abs(Number(activity.units || activity.quantity || 0)),
      price: activity.price != null ? Number(activity.price) : null
    });
  }

  const realizedSells = [];
  const openLotsByKey = new Map();

  for (const [key, events] of groups) {
    // Chronological order; on ties, process buys before sells so a same-day buy
    // can cover a same-day sell.
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

        matchedLots.push({ buyDate: lot.date, shares: round(take, 6), price: round(lot.price) });
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
        sellDate: event.date,
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
        .map(lot => ({ buyDate: lot.date, shares: round(lot.shares, 6), price: round(lot.price) }))
    );
  }

  return { realizedSells, openLotsByKey };
}

// Public: holdings + open-lot buy dates + FIFO realized sells.
async function getFullPicture() {
  const snaptrade = createClient();

  const { accounts, holdings } = await loadAccountsAndPositions(snaptrade);

  let realizedSells = [];
  let openLotsByKey = new Map();
  let activitiesError = null;

  try {
    const activities = await loadActivities(snaptrade);
    ({ realizedSells, openLotsByKey } = reconstructLots(activities));
  } catch (err) {
    // Positions still succeed even if the brokerage doesn't expose activities.
    activitiesError = err.message || String(err);
  }

  // Annotate each holding with reconstructed open-lot buy dates.
  const annotatedHoldings = holdings.map(holding => {
    const openLots = openLotsByKey.get(`${holding.accountId}|${holding.ticker}`) || [];
    const firstBuyDate = openLots.length ? openLots[0].buyDate : null;

    return { ...holding, firstBuyDate, openLots };
  });

  // Map realized sells from account id to readable account name.
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
      'realizedSells is a best-effort FIFO reconstruction from SnapTrade activity ' +
      'history; completeness depends on what the brokerage exposes. Entries with ' +
      'costBasisComplete=false had matching buys outside the available history.',
    activitiesError,
    accounts,
    holdings: annotatedHoldings,
    realizedSells: sells
  };
}

module.exports = { getPositions, getFullPicture };
