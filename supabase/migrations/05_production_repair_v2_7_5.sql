-- v2.7.5 Production Repair: Fix Supabase constraint mismatch
-- This migration restores EARLY_OPEN as the correct state after the database constraint was misaligned.

-- Drop old constraint safely
ALTER TABLE signals DROP CONSTRAINT IF EXISTS signals_state_check;

-- Normalize any legacy EARLY rows to EARLY_OPEN
UPDATE signals
SET state = 'EARLY_OPEN'
WHERE state = 'EARLY';

-- Recreate correct constraint with EARLY_OPEN, CONFIRMED, END only
ALTER TABLE signals
ADD CONSTRAINT signals_state_check
CHECK (
  state IN ('EARLY_OPEN', 'CONFIRMED', 'END')
);

-- Log completion
DO $$
BEGIN
  RAISE NOTICE 'v2.7.5 Production Repair: Constraint fixed, legacy states normalized';
END $$;
