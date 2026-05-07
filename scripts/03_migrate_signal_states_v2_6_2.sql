-- v2.6.2 Migration: Update signals_state_check constraint for new lifecycle
-- Changes: EARLY → EARLY_OPEN (v2.6.1+ architecture)

-- Drop the old constraint and recreate with new states
ALTER TABLE signals
DROP CONSTRAINT IF EXISTS signals_state_check;

ALTER TABLE signals
ADD CONSTRAINT signals_state_check CHECK (state IN ('EARLY_OPEN', 'CONFIRMED', 'END'));

-- Log the migration
COMMENT ON CONSTRAINT signals_state_check ON signals IS 'v2.6.2: Updated for EARLY_OPEN (v2.6.1+) signal lifecycle';
