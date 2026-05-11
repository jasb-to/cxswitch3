-- v8.5.0: Create alerts_sent table for Telegram cooldown tracking
-- Cooldown: 30 minutes per (symbol + mode + direction)

CREATE TABLE IF NOT EXISTS public.alerts_sent (
  id BIGSERIAL PRIMARY KEY,
  symbol VARCHAR(10) NOT NULL,
  mode VARCHAR(20) NOT NULL, -- "SNIPER" or "CONFIRMED"
  direction VARCHAR(10) NOT NULL, -- "LONG" or "SHORT"
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Index for efficient cooldown queries
  UNIQUE(symbol, mode, direction, timestamp)
);

-- Create index for cooldown lookups
CREATE INDEX IF NOT EXISTS idx_alerts_sent_cooldown 
  ON public.alerts_sent(symbol, mode, direction, timestamp DESC);

-- Enable RLS
ALTER TABLE public.alerts_sent ENABLE ROW LEVEL SECURITY;

-- Allow reads for service role (for Telegram alerts)
CREATE POLICY "Service role can select alerts" 
  ON public.alerts_sent 
  FOR SELECT 
  TO authenticated, anon
  USING (true);

-- Allow inserts for service role (to log sent alerts)
CREATE POLICY "Service role can insert alerts" 
  ON public.alerts_sent 
  FOR INSERT 
  TO authenticated, anon
  WITH CHECK (true);
