import { getCandles4H, getCandles15M, getCandles5M } from "./kraken";
import { generateSignal, Symbol } from "./strategy";
import {
  storeSignalSnapshot,
  recordAlert,
  getTelegramCooldown,
  updateTelegramCooldown,
  SignalSnapshot,
} from "./persistence";
import { detectTransition } from "./transitionDetector";
import { validateState } from "./stateValidator";
import { sendTelegramAlert } from "./telegram";
import { mapLegacyStateToUnified, assertLegacyState } from "./stateMapper";

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

      // Step 2: Generate signal (returns legacy state)
      console.log(`[ENGINE] ${symbol}: Generating signal...`);
      const signal = generateSignal(symbol, candles4H, candles1H, candles15M);

      if (!signal) {
        throw new Error("Signal generation returned null");
      }

      // Step 3: Map legacy state to unified state (WAIT→WATCHING_SHIFT, WATCH→BUILDING, LONG/SHORT→SNIPER)
      console.log(`[ENGINE] ${symbol}: Mapping state ${signal.state} → unified...`);
      const legacyState = assertLegacyState(signal.state);
      const unifiedState = mapLegacyStateToUnified(legacyState);
      const validatedState = validateState(unifiedState);

      console.log(
        `[ENGINE] ${symbol}: State mapped: ${signal.state} → ${validatedState}`
      );

      // Step 4: Detect transition
      console.log(`[ENGINE] ${symbol}: Detecting state transition...`);
      const transition = await detectTransition(symbol, validatedState);

      // Step 5: Handle alert (only on SNIPER entry)
      if (transition.isSniperEntry) {
        console.log(`[ENGINE] ${symbol}: SNIPER entry detected, checking cooldown...`);

        const cooldown = await getTelegramCooldown(symbol);
        const now = Date.now();
        const lastAlertTime = cooldown ? new Date(cooldown.lastAlertAt).getTime() : 0;
        const canAlert = now - lastAlertTime >= ALERT_COOLDOWN_MS;

        if (canAlert) {
          console.log(`[ENGINE] ${symbol}: Sending Telegram alert (cooldown OK)...`);

          // CRITICAL: telegram.ts expects legacy state names (LONG/SHORT)
          const telegramSignal = {
            ...signal,
            state: legacyState, // Keep legacy state for telegram module only
          };

          const sent = await sendTelegramAlert(telegramSignal);

          if (sent) {
            const now_iso = new Date().toISOString();
            await updateTelegramCooldown(symbol, now_iso);
            await recordAlert({
              symbol,
              state: validatedState,
              timestamp: now_iso,
              alertSent: true,
            });
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
      } else {
        console.log(
          `[ENGINE] ${symbol}: No SNIPER entry (transition: ${transition.fromState} → ${validatedState})`
        );
      }

      // Step 6: Store snapshot to in-memory storage
      console.log(`[ENGINE] ${symbol}: Storing snapshot to memory...`);
      const snapshot: SignalSnapshot = {
        symbol,
        state: validatedState,
        previousState: transition.fromState,
        confidence: signal.confidence,
        price: signal.price,
        bias: signal.bias,
        structure: signal.reason,
        updatedAt: signal.updatedAt,
        stateEnteredAt: new Date().toISOString(),
      };

      await storeSignalSnapshot(snapshot);
      results.push(snapshot);

      console.log(
        `[ENGINE] ${symbol}: ✓ Complete (${transition.fromState} → ${validatedState}, confidence: ${signal.confidence}%)`
      );

      executionLog.push({
        symbol,
        success: true,
        state: validatedState,
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
