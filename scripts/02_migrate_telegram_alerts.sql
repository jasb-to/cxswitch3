-- Migration: Add signal_id column to telegram_alerts table
-- This adds the missing column required for proper alert deduplication by signal

-- Add signal_id column if it doesn't exist
ALTER TABLE telegram_alerts ADD COLUMN IF NOT EXISTS signal_id BIGINT;

-- Add unique constraint for (signal_id, symbol, state) to prevent duplicate alerts
ALTER TABLE telegram_alerts DROP CONSTRAINT IF EXISTS telegram_alerts_signal_id_symbol_state_key;
ALTER TABLE telegram_alerts ADD CONSTRAINT telegram_alerts_signal_id_symbol_state_key UNIQUE(signal_id, symbol, state);

-- Create index on signal_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_telegram_alerts_signal_id ON telegram_alerts(signal_id);

-- Verify the changes
SELECT column_name, data_type, is_nullable 
FROM information_schema.columns 
WHERE table_name = 'telegram_alerts';
