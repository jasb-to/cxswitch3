#!/usr/bin/env node

/**
 * Test Supabase snapshot persistence layer
 * Verifies write and read operations work correctly
 */

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('[TEST] Missing Supabase env vars');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function testSnapshotPersistence() {
  console.log('[TEST] Starting snapshot persistence verification...\n');

  try {
    // Test 1: Write test snapshot
    console.log('[TEST] 1. Writing test snapshot to Supabase...');
    const testSnapshot = {
      id: 'live',
      updated_at: new Date().toISOString(),
      cards: [
        { symbol: 'BTC', signalState: 'ACTIVE_SNIPER', direction: 'LONG' },
        { symbol: 'ETH', signalState: 'BUILDING', direction: 'NEUTRAL' },
      ],
      setups: [
        { symbol: 'BTC', entry: 45000, tp: 46350, sl: 43650, direction: 'LONG' },
      ],
    };

    const { data: writeData, error: writeError } = await supabase
      .from('snapshots')
      .upsert(testSnapshot, { onConflict: 'id' })
      .select();

    if (writeError) {
      console.error('[TEST] Write failed:', writeError.message);
      return false;
    }
    console.log('[TEST] ✓ Write successful');
    console.log('[TEST]   Rows affected:', writeData?.length || 0);

    // Test 2: Read test snapshot
    console.log('\n[TEST] 2. Reading snapshot from Supabase...');
    const { data: readData, error: readError } = await supabase
      .from('snapshots')
      .select('*')
      .eq('id', 'live')
      .single();

    if (readError) {
      console.error('[TEST] Read failed:', readError.message);
      return false;
    }
    console.log('[TEST] ✓ Read successful');
    console.log('[TEST]   Updated at:', readData.updated_at);
    console.log('[TEST]   Cards count:', readData.cards?.length || 0);
    console.log('[TEST]   Setups count:', readData.setups?.length || 0);

    // Test 3: Verify data integrity
    console.log('\n[TEST] 3. Verifying data integrity...');
    const cardsMatch = JSON.stringify(readData.cards) === JSON.stringify(testSnapshot.cards);
    const setupsMatch = JSON.stringify(readData.setups) === JSON.stringify(testSnapshot.setups);

    if (!cardsMatch) {
      console.error('[TEST] Cards data mismatch!');
      return false;
    }
    if (!setupsMatch) {
      console.error('[TEST] Setups data mismatch!');
      return false;
    }
    console.log('[TEST] ✓ Data integrity verified');

    // Test 4: Update snapshot
    console.log('\n[TEST] 4. Updating snapshot...');
    const updatedSnapshot = {
      ...testSnapshot,
      cards: [
        { symbol: 'BTC', signalState: 'ACTIVE_SNIPER', direction: 'LONG' },
        { symbol: 'ETH', signalState: 'ACTIVE_SNIPER', direction: 'SHORT' },
        { symbol: 'SOL', signalState: 'BUILDING', direction: 'LONG' },
      ],
    };

    const { data: updateData, error: updateError } = await supabase
      .from('snapshots')
      .upsert(updatedSnapshot, { onConflict: 'id' })
      .select();

    if (updateError) {
      console.error('[TEST] Update failed:', updateError.message);
      return false;
    }
    console.log('[TEST] ✓ Update successful');

    // Test 5: Verify update
    console.log('\n[TEST] 5. Verifying update...');
    const { data: verifyData, error: verifyError } = await supabase
      .from('snapshots')
      .select('*')
      .eq('id', 'live')
      .single();

    if (verifyError) {
      console.error('[TEST] Verify read failed:', verifyError.message);
      return false;
    }
    if (verifyData.cards.length !== 3) {
      console.error('[TEST] Card count mismatch after update!');
      return false;
    }
    console.log('[TEST] ✓ Update verified (3 cards present)');

    console.log('\n[TEST] ✅ ALL TESTS PASSED - Persistence layer is working correctly!\n');
    return true;
  } catch (err) {
    console.error('[TEST] Exception:', err.message);
    return false;
  }
}

testSnapshotPersistence().then((success) => {
  process.exit(success ? 0 : 1);
});
