-- Migration: Create alerts_sent table for Telegram alert cooldown tracking
-- This table tracks when alerts were sent to prevent spam via cooldown mechanism
-- Date: 2026-05-18

CREATE TABLE IF NOT EXISTS public.alerts_sent (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('SNIPER', 'CONFIRMED')),
  direction TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  dedupe_key TEXT NOT NULL,
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Create index for efficient cooldown lookups (symbol + dedupe_key + timestamp range)
  -- This supports the query: WHERE symbol = X AND dedupe_key = Y AND timestamp >= cutoff_time
  CONSTRAINT alerts_sent_unique_recent UNIQUE (symbol, dedupe_key, timestamp)
);

-- Optimized index for cooldown checking (most common query pattern)
CREATE INDEX IF NOT EXISTS idx_alerts_sent_cooldown 
  ON public.alerts_sent(symbol, dedupe_key, timestamp DESC)
  WHERE timestamp > NOW() - INTERVAL '60 minutes';

-- Additional index for cleanup queries (find old records to delete)
CREATE INDEX IF NOT EXISTS idx_alerts_sent_timestamp 
  ON public.alerts_sent(timestamp);

-- Row Level Security: Allow authenticated users to query their own alerts
-- (if needed later, can be enabled with: ALTER TABLE alerts_sent ENABLE ROW LEVEL SECURITY;)

-- Comment for documentation
COMMENT ON TABLE public.alerts_sent IS 'Tracks Telegram alert delivery for cooldown/deduplication. Prevents alert spam by enforcing 30-minute cooldown per (symbol, dedupe_key).';
COMMENT ON COLUMN public.alerts_sent.dedupe_key IS 'Deduplication key: signalTransitionId (unique per transition) or fallback symbol-mode-direction for backward compatibility.';
COMMENT ON COLUMN public.alerts_sent.timestamp IS 'When the alert was sent. Used to enforce 30-minute cooldown window.';
