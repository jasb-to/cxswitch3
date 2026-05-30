-- OBSOLETE: This schema is NOT USED
-- The system uses in-memory storage (Map<string, SignalSnapshot>) in persistence.ts
-- These tables are archived for reference only and should not be created
--
-- Current production system:
-- - signalSnapshots: Map<string, SignalSnapshot> (in-memory, JavaScript object)
-- - telegramCooldowns: Map<string, TelegramCooldown> (in-memory, JavaScript object)
--
-- No external database is used. Data is ephemeral per process lifecycle.
-- If persistent storage is needed in the future, these schemas can be re-activated.

-- Legacy schema (DO NOT CREATE):
-- Signal Snapshots: Store latest signal state for each symbol
CREATE TABLE IF NOT EXISTS signal_snapshots (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('WATCHING_SHIFT', 'BUILDING', 'SNIPER')),
  previous_state TEXT NOT NULL CHECK (previous_state IN ('WATCHING_SHIFT', 'BUILDING', 'SNIPER')),
  confidence INTEGER NOT NULL,
  price FLOAT NOT NULL,
  entry FLOAT,
  stop_loss FLOAT,
  take_profit FLOAT,
  risk_reward FLOAT,
  bias TEXT NOT NULL CHECK (bias IN ('Bullish', 'Bearish', 'Neutral')),
  structure TEXT,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  state_entered_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Signal Transitions: Track state changes over time
CREATE TABLE IF NOT EXISTS signal_transitions (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  from_state TEXT NOT NULL CHECK (from_state IN ('WATCHING_SHIFT', 'BUILDING', 'SNIPER')),
  to_state TEXT NOT NULL CHECK (to_state IN ('WATCHING_SHIFT', 'BUILDING', 'SNIPER')),
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Alert History: Track all alerts sent
CREATE TABLE IF NOT EXISTS alert_history (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('WATCHING_SHIFT', 'BUILDING', 'SNIPER')),
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  alert_sent BOOLEAN NOT NULL
);

-- Telegram Cooldowns: Track when last alert was sent per symbol
CREATE TABLE IF NOT EXISTS telegram_cooldowns (
  symbol TEXT PRIMARY KEY,
  last_alert_at TIMESTAMP WITH TIME ZONE NOT NULL
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_signal_snapshots_symbol ON signal_snapshots(symbol);
CREATE INDEX IF NOT EXISTS idx_signal_transitions_symbol ON signal_transitions(symbol);
CREATE INDEX IF NOT EXISTS idx_signal_transitions_timestamp ON signal_transitions(timestamp);
CREATE INDEX IF NOT EXISTS idx_alert_history_symbol ON alert_history(symbol);
CREATE INDEX IF NOT EXISTS idx_alert_history_timestamp ON alert_history(timestamp);
