const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Client } = require('pg');
const { Snaptrade } = require('snaptrade-typescript-sdk');

// Locate the idempotent schema (CREATE TABLE/INDEX IF NOT EXISTS). Baked into the
// image at /app/schema.sql; falls back to the repo path for local `npm run sync`.
function findSchemaFile() {
  const candidates = [
    process.env.SCHEMA_PATH,
    path.join(__dirname, 'schema.sql'),
    path.join(__dirname, '..', 'db', 'init', '001_schema.sql')
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {
      // ignore and try the next candidate
    }
  }

  return null;
}

// Apply the schema on every run so the stack is self-contained: a deploy with
// only the compose file + .env-finance (no host db/init mount) still gets its
// tables. The SQL is idempotent, so this is a no-op once tables exist, and it
// also heals volumes initialized before the schema was present.
async function ensureSchema(client) {
  const schemaFile = findSchemaFile();

  if (!schemaFile) {
    console.log('Schema file not found; skipping schema ensure (assuming tables exist).');
    return;
  }

  await client.query(fs.readFileSync(schemaFile, 'utf8'));
  console.log(`Ensured database schema from ${schemaFile}`);
}

function getTicker(position) {
  return (
    position.instrument?.symbol ||
    position.instrument?.raw_symbol ||
    position.symbol?.symbol ||
    position.symbol?.raw_symbol ||
    position.symbol
  );
}

function getShares(position) {
  return Number(position.units || position.quantity || position.open_quantity || 0);
}

function shouldFetchFinnhubPrice(position) {
  if (position.cash_equivalent) return false;
  if (position.instrument?.kind === 'mutualfund') return false;
  if (!position.instrument?.symbol) return false;
  return true;
}

function getEasternTimeParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map(part => [part.type, part.value])
  );

  return {
    weekday: parts.weekday,
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  };
}

function getTimeBasedMarketSession(date = new Date()) {
  const { weekday, hour, minute } = getEasternTimeParts(date);

  if (weekday === 'Sat' || weekday === 'Sun') {
    return 'closed';
  }

  const minutes = hour * 60 + minute;

  const premarketStart = 4 * 60;       // 04:00 ET
  const regularStart = 9 * 60 + 30;    // 09:30 ET
  const regularEnd = 16 * 60;          // 16:00 ET
  const afterhoursEnd = 20 * 60;       // 20:00 ET

  if (minutes >= premarketStart && minutes < regularStart) {
    return 'premarket';
  }

  if (minutes >= regularStart && minutes < regularEnd) {
    return 'regular';
  }

  if (minutes >= regularEnd && minutes < afterhoursEnd) {
    return 'afterhours';
  }

  return 'closed';
}

async function getMarketSession(date = new Date()) {
  const timeBasedSession = getTimeBasedMarketSession(date);

  if (timeBasedSession === 'closed') {
    return 'closed';
  }

  try {
    const response = await axios.get(
      'https://finnhub.io/api/v1/stock/market-status',
      {
        params: {
          exchange: 'US',
          token: process.env.FINNHUB_API_KEY
        }
      }
    );

    const status = response.data;

    if (status && status.holiday) {
      console.log(`Finnhub market status: holiday=${status.holiday}`);
      return 'closed';
    }

    return timeBasedSession;
  } catch (err) {
    console.log(
      'Finnhub market status lookup failed; using time-based session:',
      err.response?.status || err.status || err.message
    );

    return timeBasedSession;
  }
}

async function fetchFinnhubQuotePrice(ticker) {
  const quoteResponse = await axios.get(
    'https://finnhub.io/api/v1/quote',
    {
      params: {
        symbol: ticker,
        token: process.env.FINNHUB_API_KEY
      }
    }
  );

  const price = Number(quoteResponse.data.c || 0);

  if (!price) {
    return null;
  }

  return {
    price,
    source: 'finnhub_quote'
  };
}

async function fetchFinnhubCandlePrice(ticker) {
  const nowSeconds = Math.floor(Date.now() / 1000);

  // Look back far enough to catch sparse pre/post-market candles.
  const fromSeconds = nowSeconds - 6 * 60 * 60;

  const candleResponse = await axios.get(
    'https://finnhub.io/api/v1/stock/candle',
    {
      params: {
        symbol: ticker,
        resolution: '1',
        from: fromSeconds,
        to: nowSeconds,
        token: process.env.FINNHUB_API_KEY
      }
    }
  );

  const data = candleResponse.data;

  if (!data || data.s !== 'ok' || !Array.isArray(data.c) || data.c.length === 0) {
    return null;
  }

  // Use the latest non-zero close from the returned candles.
  for (let i = data.c.length - 1; i >= 0; i--) {
    const price = Number(data.c[i] || 0);

    if (price) {
      return {
        price,
        source: 'finnhub_candle_1m'
      };
    }
  }

  return null;
}

async function fetchBestFinnhubPrice(ticker, session) {
  if (session === 'premarket' || session === 'afterhours') {
    try {
      const candlePrice = await fetchFinnhubCandlePrice(ticker);

      if (candlePrice) {
        return candlePrice;
      }

      console.log(`No candle data for ${ticker}; falling back to quote.`);
    } catch (err) {
      console.log(
        `Candle lookup failed for ${ticker}; falling back to quote:`,
        err.response?.status || err.status || err.message
      );
    }
  }

  try {
    const quotePrice = await fetchFinnhubQuotePrice(ticker);

    if (quotePrice) {
      return {
        price: quotePrice.price,
        source: session === 'regular'
          ? 'finnhub_quote'
          : 'finnhub_quote_fallback'
      };
    }
  } catch (err) {
    console.log(
      `Quote lookup failed for ${ticker}:`,
      err.response?.status || err.status || err.message
    );
  }

  return null;
}

async function main() {
  const snaptrade = new Snaptrade({
    clientId: process.env.SNAPTRADE_CLIENT_ID,
    consumerKey: process.env.SNAPTRADE_CONSUMER_KEY
  });

  const client = new Client({
    connectionString: process.env.DATABASE_URL
  });

  await client.connect();

  await ensureSchema(client);

  const runTimeResult = await client.query('SELECT NOW() AS run_time');
  const runTime = runTimeResult.rows[0].run_time;

  const session = await getMarketSession();
  console.log(`Market session: ${session}`);

  const accountsResponse = await snaptrade.accountInformation.listUserAccounts({
    userId: process.env.SNAPTRADE_USER_ID,
    userSecret: process.env.SNAPTRADE_USER_SECRET
  });

  const accounts = accountsResponse.data;
  console.log(`Found ${accounts.length} account(s).`);

  await client.query('DELETE FROM holdings');

  const tickers = new Set();

  for (const account of accounts) {
    console.log(`Reading account: ${account.name || account.id}`);

    let accountTotalValue = 0;

    const positionsResponse = await snaptrade.accountInformation.getAllAccountPositions({
      userId: process.env.SNAPTRADE_USER_ID,
      userSecret: process.env.SNAPTRADE_USER_SECRET,
      accountId: account.id
    });

    const positions = positionsResponse.data?.results || [];

    for (const position of positions) {
      const ticker = getTicker(position);
      const shares = getShares(position);
      const snapPrice = Number(position.price || 0);
      const costBasis = position.cost_basis ? Number(position.cost_basis) : null;
      const marketValue = snapPrice ? shares * snapPrice : null;

      if (!ticker || !shares) continue;

      if (marketValue) {
        accountTotalValue += marketValue;
      }

      if (shouldFetchFinnhubPrice(position)) {
        tickers.add(ticker);
      }

      const row = [
        account.id,
        account.name || '',
        ticker,
        shares,
        costBasis,
        marketValue,
        runTime
      ];

      await client.query(
        `
        INSERT INTO holdings
        (account_id, account_name, ticker, shares, cost_basis, market_value, snapshot_time)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        row
      );

      await client.query(
        `
        INSERT INTO holdings_history
        (account_id, account_name, ticker, shares, cost_basis, market_value, snapshot_time)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        row
      );

      console.log(
        `Account=${account.name || account.id} Ticker=${ticker} Shares=${shares} Value=${marketValue}`
      );
    }

    await client.query(
      `
      INSERT INTO portfolio_snapshots
      (snapshot_time, account_name, total_value)
      VALUES ($1, $2, $3)
      `,
      [runTime, account.name || account.id, accountTotalValue]
    );

    console.log(`Snapshot: ${account.name || account.id} = ${accountTotalValue}`);
  }

  for (const ticker of tickers) {
    const result = await fetchBestFinnhubPrice(ticker, session);

    if (!result) {
      console.log(`No Finnhub price for ${ticker}`);
      continue;
    }

    await client.query(
      `
      INSERT INTO prices
      (ticker, price, timestamp, session, source)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [
        ticker,
        result.price,
        runTime,
        session,
        result.source
      ]
    );

    console.log(
      `Finnhub price: ${ticker} ${result.price} session=${session} source=${result.source}`
    );
  }

  await client.end();
}

main().catch(err => {
  console.error("Status:", err.status);
  console.error("Body:", err.responseBody);
  console.error("Message:", err.message);
  process.exit(1);
});
