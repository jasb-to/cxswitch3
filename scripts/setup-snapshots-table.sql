-- v23.0.0 Migration: Create snapshots table for durable snapshot storage
-- This table persists the live snapshot across process restarts

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY DEFAULT 'live',
  updated_at TIMESTAMPTZ NOT NULL,
  cards JSONB NOT NULL DEFAULT '[]',
  setups JSONB NOT NULL DEFAULT '[]',
  last_modified TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE snapshots ENABLE ROW LEVEL SECURITY;

-- Create policy to allow reads from anonymous users (for /api/signals endpoint)
CREATE POLICY "Allow reads for anonymous users" ON snapshots
  FOR SELECT
  USING (true);

-- Create policy to allow writes from service role (for cron updates)
CREATE POLICY "Allow writes from service role" ON snapshots
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Create index on last_modified for optimization
CREATE INDEX IF NOT EXISTS snapshots_last_modified_idx ON snapshots(last_modified DESC);

-- Insert default empty snapshot if it doesn't exist
INSERT INTO snapshots (id, updated_at, cards, setups)
VALUES ('live', NOW(), '[]', '[]')
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE snapshots IS 'v23.0.0: Durable storage for live signal snapshot. Single row with id="live" contains current scanner state.';
