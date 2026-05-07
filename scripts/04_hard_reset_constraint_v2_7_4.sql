-- v2.7.4 Migration: Hard Reset Constraint Repair & Data Cleanup
-- Purpose: Completely remove old constraint, recreate cleanly, and normalize legacy data
-- Status: CRITICAL - Must run before v2.7.4 deployment

-- ============================================
-- STEP 1: Export backup comment
-- ============================================
-- [DB BACKUP] Export complete
-- (Run before this script in Supabase)

-- ============================================
-- STEP 2: Hard reset signals table constraint
-- ============================================

-- Drop the old constraint (may still contain legacy EARLY state)
ALTER TABLE signals
DROP CONSTRAINT IF EXISTS signals_state_check;

-- Recreate with clean EARLY_OPEN state (v2.7.4+)
ALTER TABLE signals
ADD CONSTRAINT signals_state_check
CHECK (
  state = ANY (
    ARRAY[
      'EARLY_OPEN',
      'CONFIRMED',
      'END'
    ]
  )
);

-- ============================================
-- STEP 3: Verify constraint immediately
-- ============================================
-- Run this query to verify:
-- SELECT conname, pg_get_constraintdef(oid)
-- FROM pg_constraint
-- WHERE conrelid = 'signals'::regclass;
--
-- Expected output must contain:
-- CHECK ((state = ANY (ARRAY['EARLY_OPEN'::text, 'CONFIRMED'::text, 'END'::text])))

-- ============================================
-- STEP 4: Clean legacy data
-- ============================================

-- Normalize any remaining EARLY rows to EARLY_OPEN
UPDATE signals
SET state='EARLY_OPEN'
WHERE state='EARLY';

-- ============================================
-- STEP 5: Verify data cleanup
-- ============================================
-- Run this query to verify no legacy states remain:
-- SELECT state, COUNT(*)
-- FROM signals
-- GROUP BY state;
--
-- Expected output:
-- EARLY_OPEN | X
-- CONFIRMED  | Y
-- END        | Z
-- (NO raw EARLY rows)

-- ============================================
-- STEP 6: Drop old function if exists
-- ============================================
DROP FUNCTION IF EXISTS get_active_signals();
DROP FUNCTION IF EXISTS cleanup_expired_signals();

-- ============================================
-- STEP 7: Mark migration complete
-- ============================================
COMMENT ON TABLE signals IS 'v2.7.4: Hard reset constraint repair - EARLY_OPEN + CONFIRMED + END states only';
