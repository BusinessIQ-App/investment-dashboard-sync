CREATE TABLE IF NOT EXISTS holdings (
    account_id TEXT,
    account_name TEXT,
    ticker TEXT NOT NULL,
    shares NUMERIC,
    cost_basis NUMERIC,
    market_value NUMERIC,
    snapshot_time TIMESTAMP
);

CREATE TABLE IF NOT EXISTS holdings_history (
    snapshot_time TIMESTAMP NOT NULL,
    account_id TEXT,
    account_name TEXT,
    ticker TEXT NOT NULL,
    shares NUMERIC NOT NULL,
    cost_basis NUMERIC,
    market_value NUMERIC
);

CREATE TABLE IF NOT EXISTS prices (
    ticker TEXT NOT NULL,
    price NUMERIC,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    session TEXT DEFAULT 'regular',
    source TEXT DEFAULT 'finnhub_quote'
);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    snapshot_time TIMESTAMP NOT NULL,
    account_name TEXT NOT NULL,
    total_value NUMERIC NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_holdings_ticker ON holdings(ticker);
CREATE INDEX IF NOT EXISTS idx_holdings_account ON holdings(account_name);

CREATE INDEX IF NOT EXISTS idx_holdings_history_time ON holdings_history(snapshot_time);
CREATE INDEX IF NOT EXISTS idx_holdings_history_ticker ON holdings_history(ticker);
CREATE INDEX IF NOT EXISTS idx_holdings_history_account ON holdings_history(account_name);

CREATE INDEX IF NOT EXISTS idx_prices_ticker_time ON prices(ticker, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_prices_session ON prices(session);

CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_time ON portfolio_snapshots(snapshot_time);
CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_account ON portfolio_snapshots(account_name);
