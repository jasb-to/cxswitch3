-- Create signals table for persistent signal storage
CREATE TABLE IF NOT EXISTS signals (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  state TEXT NOT NULL CHECK (state IN ('EARLY', 'CONFIRMED', 'END')),
  entry_price NUMERIC,
  stop_loss NUMERIC,
  take_profit NUMERIC,
  confidence INTEGER CHECK (confidence >= 0 AND confidence <= 100),
  breakout_level NUMERIC NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(symbol, direction, created_at)
);

-- Create cron execution log
CREATE TABLE IF NOT EXISTS cron_runs (
  id BIGSERIAL PRIMARY KEY,
  ran_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  signals_found INTEGER DEFAULT 0,
  duration_ms INTEGER,
  logs TEXT
);

-- Create telegram alerts tracking for anti-spam
CREATE TABLE IF NOT EXISTS telegram_alerts (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  state TEXT NOT NULL,
  sent_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol);
CREATE INDEX IF NOT EXISTS idx_signals_direction ON signals(direction);
CREATE INDEX IF NOT EXISTS idx_signals_state ON signals(state);
CREATE INDEX IF NOT EXISTS idx_signals_updated_at ON signals(updated_at);
CREATE INDEX IF NOT EXISTS idx_telegram_alerts_symbol_state ON telegram_alerts(symbol, state);
