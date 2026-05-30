import { getCandles4H, getCandles15M, getCandles5M, getCurrentPrice } from "./kraken";
import { generateSignal, Symbol } from "./strategy";
import {
  storeSignalSnapshot,
  getTelegramCooldown,
  updateTelegramCooldown,
  SignalSnapshot,
} from "./persistence";
import { sendTelegramAlert } from "./telegram";

const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 60 minutes

/**
 * SINGLE SOURCE OF TRUTH: generateAndStoreSignals()
 * 
 * This is the ONLY function that:
 * - Fetches candles from Kraken
 * - Generates signals via strategy.ts
 * - Maps states from legacy to unified
 * - Detects state transitions
 * - Writes to Supabase
 * - Triggers Telegram alerts
 * 
 * Called ONLY by cron. Never called by API or UI.
 */
export async function generateAndStoreSignals() {
  const symbols: Symbol[] = ["BTC", "ETH", "SOL"];
  const results: SignalSnapshot[] = [];
  const executionLog: {
    symbol: string;
    success: boolean;
    state?: string;
    error?: string;
  }[] = [];

  for (const symbol of symbols) {
    try {
      console.log(`[ENGINE] ========== Processing ${symbol} ==========`);

      // Step 1: Fetch candles
      console.log(`[ENGINE] ${symbol}: Fetching candles...`);
      const [candles4H, candles1H, candles15M] = await Promise.all([
        getCandles4H(symbol),
        getCandles15M(symbol),
        getCandles5M(symbol),
      ]);

      if (!candles4H?.length || !candles1H?.length || !candles15M?.length) {
        throw new Error(
          `Incomplete candle data: 4H=${candles4H?.length || 0}, 1H=${candles1H?.length || 0}, 15M=${candles15M?.length || 0}`
        );
      }

      // Step 2: Fetch live current price
      console.log(`[ENGINE] ${symbol}: Fetching live price...`);
      const livePrice = await getCurrentPrice(symbol);
      
      if (livePrice === 0) {
        throw new Error(`Failed to fetch live price for ${symbol}`);
      }

      // Step 3: Generate signal with live price
      console.log(`[ENGINE] ${symbol}: Generating signal (live price: $${livePrice.toFixed(2)})...`);
      const signal = generateSignal(symbol, candles4H, candles1H, candles15M, livePrice);

      if (!signal) {
        throw new Error("Signal generation returned null");
      }

      // Step 3: Check for SNIPER execution trigger
      if (signal.isSniper) {
        console.log(`[ENGINE] ${symbol}: SNIPER TRIGGER DETECTED, checking cooldown...`);

        const cooldown = await getTelegramCooldown(symbol);
        const now = Date.now();
        const lastAlertTime = cooldown ? new Date(cooldown.lastAlertAt).getTime() : 0;
        const canAlert = now - lastAlertTime >= ALERT_COOLDOWN_MS;

        if (canAlert) {
          console.log(`[ENGINE] ${symbol}: Sending Telegram alert (cooldown OK)...`);

          // Send signal directly with isSniper flag
          const sent = await sendTelegramAlert(signal);

          if (sent) {
            const now_iso = new Date().toISOString();
            await updateTelegramCooldown(symbol, now_iso);
            console.log(`[ENGINE] ${symbol}: Alert sent successfully`);
          } else {
            console.warn(`[ENGINE] ${symbol}: Alert send failed`);
          }
        } else {
          const minutesUntilNext = Math.ceil(
            (ALERT_COOLDOWN_MS - (now - lastAlertTime)) / 60000
          );
          console.log(
            `[ENGINE] ${symbol}: Alert in cooldown (${minutesUntilNext}m remaining)`
          );
        }
      } else if (signal.isBuilding) {
        console.log(`[ENGINE] ${symbol}: BUILDING (awaiting SNIPER trigger)`);
      } else {
        console.log(`[ENGINE] ${symbol}: No setup (isBuilding=false)`);
      }

      // Step 4: Store snapshot to in-memory storage
      console.log(`[ENGINE] ${symbol}: Storing snapshot...`);
      const snapshot: SignalSnapshot = {
        symbol,
        isBuilding: signal.isBuilding,
        isSniper: signal.isSniper,
        confidence: signal.confidence,
        price: signal.price,
        adx: signal.adx,
        stochK: signal.stochK,
        stochD: signal.stochD,
        bias: signal.bias,
        reason: signal.reason,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        riskRewardRatio: signal.riskRewardRatio,
        updatedAt: signal.updatedAt,
      };

      // Validate snapshot integrity
      console.log(`[ENGINE] ${symbol}: Validating snapshot integrity...`);
      validateSnapshot(signal, snapshot, symbol);

      await storeSignalSnapshot(snapshot);
      results.push(snapshot);

      console.log(
        `[ENGINE] ${symbol}: ✓ Complete (isSniper=${signal.isSniper}, isBuilding=${signal.isBuilding}, ADX=${signal.adx.toFixed(1)}, confidence: ${signal.confidence}%)`
      );

      executionLog.push({
        symbol,
        success: true,
        // Display state for logging: BUILDING or SNIPER are the only real states
        // (not WATCHING_SHIFT - that was legacy, now it's just "no setup" when both isBuilding and isSniper are false)
        state: signal.isSniper ? "SNIPER" : signal.isBuilding ? "BUILDING" : "NO_SETUP",
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[ENGINE] ✗ ERROR processing ${symbol}: ${errorMsg}`);
      executionLog.push({
        symbol,
        success: false,
        error: errorMsg,
      });
      // Continue processing other symbols even if one fails
    }
  }

  // Log execution summary
  const successCount = executionLog.filter((e) => e.success).length;
  console.log(
    `[ENGINE] ========== EXECUTION COMPLETE: ${successCount}/${symbols.length} symbols processed ==========`
  );
  executionLog.forEach((log) => {
    if (log.success) {
      console.log(`[ENGINE]   ✓ ${log.symbol}: ${log.state}`);
    } else {
      console.log(`[ENGINE]   ✗ ${log.symbol}: ${log.error}`);
    }
  });

  return results;
}

/**
 * Validates that snapshot exactly matches the signal object
 * Logs any mismatches (single source of truth verification)
 */
function validateSnapshot(signal: ReturnType<typeof generateSignal>, snapshot: SignalSnapshot, symbol: string) {
  const mismatches: string[] = [];

  // Check all critical fields
  if (snapshot.symbol !== signal.symbol) mismatches.push(`symbol: ${snapshot.symbol} !== ${signal.symbol}`);
  if (snapshot.isBuilding !== signal.isBuilding) mismatches.push(`isBuilding: ${snapshot.isBuilding} !== ${signal.isBuilding}`);
  if (snapshot.isSniper !== signal.isSniper) mismatches.push(`isSniper: ${snapshot.isSniper} !== ${signal.isSniper}`);
  if (snapshot.confidence !== signal.confidence) mismatches.push(`confidence: ${snapshot.confidence} !== ${signal.confidence}`);
  if (snapshot.price !== signal.price) mismatches.push(`price: ${snapshot.price} !== ${signal.price}`);
  if (snapshot.adx !== signal.adx) mismatches.push(`adx: ${snapshot.adx} !== ${signal.adx}`);
  if (snapshot.stochK !== signal.stochK) mismatches.push(`stochK: ${snapshot.stochK} !== ${signal.stochK}`);
  if (snapshot.stochD !== signal.stochD) mismatches.push(`stochD: ${snapshot.stochD} !== ${signal.stochD}`);
  if (snapshot.bias !== signal.bias) mismatches.push(`bias: ${snapshot.bias} !== ${signal.bias}`);
  if (snapshot.stopLoss !== signal.stopLoss) mismatches.push(`stopLoss: ${snapshot.stopLoss} !== ${signal.stopLoss}`);
  if (snapshot.takeProfit !== signal.takeProfit) mismatches.push(`takeProfit: ${snapshot.takeProfit} !== ${signal.takeProfit}`);
  if (snapshot.riskRewardRatio !== signal.riskRewardRatio) mismatches.push(`riskRewardRatio: ${snapshot.riskRewardRatio} !== ${signal.riskRewardRatio}`);

  if (mismatches.length > 0) {
    console.warn(`[ENGINE] ⚠️  SNAPSHOT MISMATCH for ${symbol}: ${mismatches.join(", ")}`);
  } else {
    console.log(`[ENGINE] ✓ Snapshot integrity verified for ${symbol}`);
  }
}
