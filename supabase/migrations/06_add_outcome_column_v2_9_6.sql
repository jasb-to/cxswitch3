-- v2.9.6 Stabilization: Add outcome column and constraint to signals table
-- This migration adds the missing outcome column that tracks how trades exit
-- Fixes: STRUCTURE_INVALIDATED constraint violation, improves lifecycle tracking

-- ============================================
-- STEP 1: Add outcome column
-- ============================================

ALTER TABLE signals
ADD COLUMN IF NOT EXISTS outcome TEXT;

-- ============================================
-- STEP 2: Add outcome constraint
-- ============================================

-- Drop old constraint if it exists
ALTER TABLE signals DROP CONSTRAINT IF EXISTS signals_outcome_check;

-- Create new constraint with all valid outcomes
ALTER TABLE signals
ADD CONSTRAINT signals_outcome_check
CHECK (
  outcome IS NULL
  OR outcome = ANY (
    ARRAY[
      'TP',
      'SL',
      'EXPIRED',
      'MANUAL',
      'STRUCTURE_INVALIDATED'
    ]
  )
);

-- ============================================
-- STEP 3: Add pnl column for trade P&L tracking
-- ============================================

ALTER TABLE signals
ADD COLUMN IF NOT EXISTS pnl NUMERIC;

-- ============================================
-- STEP 4: Add last_checked_candle for state management
-- ============================================

ALTER TABLE signals
ADD COLUMN IF NOT EXISTS last_checked_candle TEXT DEFAULT NULL;

-- ============================================
-- STEP 5: Verify schema
-- ============================================
-- Run this query to verify:
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_name = 'signals'
-- ORDER BY ordinal_position;
--
-- Expected new columns:
-- outcome        | text    | yes
-- pnl            | numeric | yes
-- last_checked_candle | text | yes

-- ============================================
-- STEP 6: Create index for outcome lookups
-- ============================================

CREATE INDEX IF NOT EXISTS idx_signals_outcome ON signals(outcome);

-- ============================================
-- STEP 7: Mark migration complete
-- ============================================

COMMENT ON TABLE signals IS 'v2.9.6: Added outcome column and constraint, improved lifecycle tracking';
