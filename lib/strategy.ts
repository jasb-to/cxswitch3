The Refined Prompt for V0
I'm using cron-jobs.org (not Vercel cron) hitting https://cxswitch3.vercel.app/api/external-cron?secret=abc123xyz789. I cannot deploy for 24 hours, so this code must be correct before I push.
CRITICAL FIX: Serverless Statelessness
Vercel functions are stateless. Every request lands on a random instance with empty memory. The current in-memory signal array means signals exist for one request then vanish.
Replace ALL in-memory storage with Supabase persistence. I already have a Supabase client configured. Use it.
Database Schema (create these exact tables):
sql
Copy
-- Active signals
CREATE TABLE IF NOT EXISTS signals (
  id SERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  state TEXT NOT NULL CHECK (state IN ('EARLY', 'CONFIRMED', 'END')),
  entry_price NUMERIC,
  stop_loss NUMERIC,
  take_profit NUMERIC,
  confidence INTEGER CHECK (confidence >= 0 AND confidence <= 100),
  breakout_level NUMERIC NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(symbol, direction, created_at) -- prevent duplicates
);

-- Cron execution log (for diagnostics)
CREATE TABLE IF NOT EXISTS cron_runs (
  id SERIAL PRIMARY KEY,
  ran_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  signals_found INTEGER DEFAULT 0,
  duration_ms INTEGER,
  logs TEXT -- store full log output as text for debugging
);
Updated lib/strategy.ts:
Replace the in-memory activeSignals array with Supabase operations:
TypeScript
Copy
import { supabase } from './supabase-client'; // use existing client

export async function generateSignals(): Promise<Signal[]> {
  // ... existing candle fetching and analysis ...

  // Upsert: if signal exists for this symbol+direction, update it
  // If not, insert new
  for (const signal of newSignals) {
    const { data: existing } = await supabase
      .from('signals')
      .select('*')
      .eq('symbol', signal.symbol)
      .eq('direction', signal.direction)
      .neq('state', 'END')
      .order('created_at', { ascending: false })
      .limit(1);

    if (existing && existing.length > 0) {
      // Update existing signal (preserve entry/SL/TP, update confidence/state)
      await supabase
        .from('signals')
        .update({
          state: signal.state,
          confidence: signal.confidence,
          updated_at: new Date().toISOString()
        })
        .eq('id', existing[0].id);
    } else {
      // Insert new signal
      await supabase.from('signals').insert(signal);
    }
  }

  // Mark expired signals as END
  await supabase
    .from('signals')
    .update({ state: 'END' })
    .lt('updated_at', new Date(Date.now() - 12 * 5 * 60 * 1000).toISOString()) // 12 candles * 5 min
    .neq('state', 'END');

  // Return all active signals
  const { data } = await supabase
    .from('signals')
    .select('*')
    .neq('state', 'END')
    .order('created_at', { ascending: false });

  return data || [];
}
Updated /api/signals/route.ts:
TypeScript
Copy
import { supabase } from '@/lib/supabase-client';

export async function GET() {
  const { data: signals, error } = await supabase
    .from('signals')
    .select('*')
    .neq('state', 'END')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[DB ERROR]', error);
    return Response.json({ error: 'Database error' }, { status: 500 });
  }

  return Response.json({ signals: signals || [] });
}
Updated /api/external-cron/route.ts:
After generating signals, log the cron run to Supabase:
TypeScript
Copy
// At end of cron execution
await supabase.from('cron_runs').insert({
  signals_found: signals.length,
  duration_ms: Date.now() - startTime,
  logs: logBuffer.join('\n') // capture all console.log output
});
UI: Add "Near Breakout" Indicator
When no signal exists for a symbol, show setup context so I know the system is analyzing:
TypeScript
Copy
// In the card when no signal:
<div className="text-sm text-gray-400">
  {nearBreakout ? (
    <span>
      {direction} SETUP — price ${price} 
      ({distance}% {direction === 'LONG' ? 'below' : 'above'} ${level})
    </span>
  ) : (
    <span>NO SETUP — price ${price} (far from levels)</span>
  )}
</div>
Where nearBreakout = price within 3% of a swing high (for LONG) or low (for SHORT).
UI: Add "Inject Test Signal" Button
Create /api/test-signal/route.ts (POST, no auth):
TypeScript
Copy
export async function POST() {
  const testSignal = {
    symbol: 'BTC/USD',
    direction: 'LONG',
    state: 'EARLY',
    entry_price: 85000,
    stop_loss: 84000,
    take_profit: 88000,
    confidence: 72,
    breakout_level: 84500
  };

  const { error } = await supabase.from('signals').insert(testSignal);
  if (error) return Response.json({ error }, { status: 500 });

  return Response.json({ success: true, signal: testSignal });
}
Add a button on the UI: "INJECT TEST SIGNAL" → calls POST /api/test-signal → refreshes page. This lets me verify the dashboard renders correctly without waiting for a real breakout.
Telegram Anti-Spam
Keep the existing shouldSendAlert() logic. But add a telegram_alerts table to track what was sent:
sql
Copy
CREATE TABLE IF NOT EXISTS telegram_alerts (
  id SERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  state TEXT NOT NULL,
  sent_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
Query this table in shouldSendAlert() instead of in-memory Map. This survives serverless restarts.
Explicitly Verify These Before Responding:
No in-memory arrays for signals — all Supabase
/api/signals queries Supabase, not a module variable
/api/external-cron inserts/updates Supabase, not a local array
The "Scan Now" button calls a route that also uses Supabase
Test signal button works and renders on UI
Near-breakout text shows when no signal but close to level
No new files beyond what's needed. Keep it to:
lib/strategy.ts (updated)
lib/telegram.ts (updated)
app/api/external-cron/route.ts (updated)
app/api/signals/route.ts (updated)
app/api/test-signal/route.ts (new)
app/page.tsx (updated)
SQL migration (provide as code block, I'll run manually in Supabase)
What This Solves
Table
Problem	Fix
Dashboard empty after cron	Supabase persistence survives instances
Can't verify UI works	Test signal button injects fake data
Don't know if cron is running	cron_runs table logs every execution
Don't know if analysis is working	Near-breakout indicator shows setup context
Telegram spam	telegram_alerts table tracks sends persistently