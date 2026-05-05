# CRITICAL BUG FIX: Telegram Alerts 400 Error — Schema Mismatch

## Issue Identified

The Vercel runtime logs show **all telegram_alerts queries returning 400 errors**:
- GET telegram_alerts → 400
- POST telegram_alerts → 400  
- DELETE telegram_alerts → 400

## Root Cause

**Schema Mismatch**: The database schema and application code are out of sync.

### Current Database Schema (scripts/01_init_db.sql)
```sql
CREATE TABLE IF NOT EXISTS telegram_alerts (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  state TEXT NOT NULL,
  sent_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### Current Application Code (lib/telegram.ts)
Tries to use non-existent `signal_id` column:
```typescript
// Line 24-26: Query uses signal_id
.eq("signal_id", signal_id)
.eq("symbol", symbol)
.eq("state", newState)

// Line 99-104: Insert uses signal_id
.insert({
  signal_id: signal.id,  // ← Column doesn't exist!
  symbol: signal.symbol,
  state: signal.state,
})
```

Result: **Supabase returns 400 Bad Request** because the column doesn't exist.

## Manual Fix Required

**You must run these SQL commands in your Supabase dashboard:**

```sql
-- Step 1: Add signal_id column
ALTER TABLE telegram_alerts ADD COLUMN signal_id BIGINT;

-- Step 2: Make signal_id NOT NULL for existing rows (set to 0 as placeholder)
UPDATE telegram_alerts SET signal_id = 0 WHERE signal_id IS NULL;
ALTER TABLE telegram_alerts ALTER COLUMN signal_id SET NOT NULL;

-- Step 3: Drop old constraint if exists
ALTER TABLE telegram_alerts DROP CONSTRAINT IF EXISTS telegram_alerts_signal_id_symbol_state_key;

-- Step 4: Add unique constraint to prevent duplicate alerts per signal
ALTER TABLE telegram_alerts ADD CONSTRAINT telegram_alerts_signal_id_symbol_state_key UNIQUE(signal_id, symbol, state);

-- Step 5: Create index on signal_id for fast lookups
CREATE INDEX IF NOT EXISTS idx_telegram_alerts_signal_id ON telegram_alerts(signal_id);

-- Step 6: Verify the schema is correct
SELECT column_name, data_type, is_nullable 
FROM information_schema.columns 
WHERE table_name = 'telegram_alerts'
ORDER BY ordinal_position;
```

## Steps to Apply Fix

1. **Go to your Supabase Dashboard** → SQL Editor
2. **Create new query** and paste the SQL commands above
3. **Execute** them sequentially
4. **Verify** the last SELECT shows `signal_id BIGINT NOT NULL`
5. **Restart** your cron jobs — alerts will now work correctly

## Expected Result After Fix

✓ shouldSendAlert() queries will succeed (200 status, not 400)
✓ Telegram alerts will be deduplicated properly by signal_id
✓ No more repeated alerts for the same signal
✓ Each new signal gets one EARLY alert, one CONFIRMED alert

## Code Changes Already Made

- `scripts/01_init_db.sql` — Updated to include signal_id in schema
- `scripts/02_migrate_telegram_alerts.sql` — Created migration script
- `lib/telegram.ts` — Already using signal_id in queries (no changes needed)
- `app/api/cron/route.ts` — Already passing signal_id to shouldSendAlert() (no changes needed)

---

After applying the SQL fix, the next cron run should show clean alert deduplication working correctly.
