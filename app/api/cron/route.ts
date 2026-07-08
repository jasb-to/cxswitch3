// app/api/cron/route.ts — v29.1 PATCH
// ============================================================
// Changes from v28.3 to v29.1:
//   1. Import setRegimePersistence from strategy
//   2. Wire regime persistence to KV (using existing redis)
//   3. Add regime evaluation on daily close
//   4. Change generateSignal() to await (now async)
//   5. Add regime logging
// ============================================================

// STEP 1: Add this import at the top
import { setRegimePersistence, evaluateRegime } from "@/lib/strategy";
import { redis } from "@/lib/state"; // already imported

// STEP 2: Add this inside your cron init (before the main loop)
// Put it right after: setExitPersistence(persistExit, loadExits);

setRegimePersistence(
  async (regime) => {
    await redis.set(`regime_${regime.symbol}`, JSON.stringify(regime), { ex: 30 * 24 * 60 * 60 });
  },
  async (symbol) => {
    const data = await redis.get(`regime_${symbol}`);
    return data ? (typeof data === "string" ? JSON.parse(data) : data) : null;
  }
);

// STEP 3: Add regime evaluation before the pair loop
// Put this right after: await loadExitsStrategy();

const lastRegimeEval = await redis.get("last_regime_eval");
const today = new Date().toISOString().split("T")[0];

if (lastRegimeEval !== today) {
  log("[REGIME] Daily candle closed — evaluating regimes...");
  for (const pair of PAIRS) {
    const candles4h = candles4hMap[pair] || await getCandles(pair, 240);
    const candles1d = aggregateTo1D(candles4h);
    if (candles1d.length >= 25) {
      const regime = evaluateRegime(pair, candles1d, candles4h);
      await redis.set(`regime_${pair}`, JSON.stringify(regime), { ex: 30 * 24 * 60 * 60 });
      log(`[REGIME] ${pair}: ${regime.direction} ${regime.strength} (conf ${regime.confidence})`);
    }
  }
  await redis.set("last_regime_eval", today, { ex: 48 * 60 * 60 });
} else {
  log("[REGIME] Using cached regimes (evaluated today)");
}

// STEP 4: Change generateSignal calls to await
// OLD: const result = generateSignal(pair, candles1h, candles4h, candles15m, activeTrades, currentPrice);
// NEW: const result = await generateSignal(pair, candles1h, candles4h, candles15m, activeTrades, currentPrice);

// Find this line in your cron:
//   const result = generateSignal(pair, candles1h, candles4h, candles15m, activeTrades, currentPrice);
// Change to:
//   const result = await generateSignal(pair, candles1h, candles4h, candles15m, activeTrades, currentPrice);

// Also change inside the insufficient candles fallback:
// OLD: const result = generateSignal(pair, candles1h || [], candles4h, candles15m || [], activeTrades, currentPrice);
// NEW: const result = await generateSignal(pair, candles1h || [], candles4h, candles15m || [], activeTrades, currentPrice);

// STEP 5: Add regime info to market data logging (optional but useful)
// In the debug loop, the regime info is already logged by generateSignal
// You should see lines like:
//   [STRAT] BTC REGIME: SHORT MEDIUM conf=85 (since 2026-07-05)
//   [STRAT] BTC Regime reasons: daily_ema_short:+30, daily_lh_ll:+20, ...
