-- Create alerts_sent table for deduplication
-- Tracks sent alerts to prevent duplicates within cooldown window
-- v21.3.0: Critical for preventing alert spam and duplicate trades

CREATE TABLE IF NOT EXISTS alerts_sent (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  symbol VARCHAR(10) NOT NULL,
  mode VARCHAR(20) NOT NULL, -- SNIPER or CONFIRMED
  direction VARCHAR(10) NOT NULL, -- LONG or SHORT
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Composite index for efficient cooldown lookups
  UNIQUE(symbol, mode, direction, timestamp)
);

-- Index for fast lookups during cooldown checks
CREATE INDEX IF NOT EXISTS idx_alerts_sent_cooldown 
ON alerts_sent(symbol, mode, direction, timestamp DESC);

-- Grant permissions
GRANT SELECT, INSERT ON alerts_sent TO authenticated;
GRANT SELECT, INSERT ON alerts_sent TO service_role;

-- Enable RLS
ALTER TABLE alerts_sent ENABLE ROW LEVEL SECURITY;

-- RLS: Allow service role to manage all records
CREATE POLICY "service_role_all" ON alerts_sent
  FOR ALL
  USING (current_user_id() = auth.uid() OR auth.role() = 'service_role')
  WITH CHECK (current_user_id() = auth.uid() OR auth.role() = 'service_role');

-- RLS: Allow authenticated users to insert their own alerts
CREATE POLICY "authenticated_insert" ON alerts_sent
  FOR INSERT
  WITH CHECK (true);

-- RLS: Allow authenticated users to read recent alerts
CREATE POLICY "authenticated_select" ON alerts_sent
  FOR SELECT
  USING (true);
