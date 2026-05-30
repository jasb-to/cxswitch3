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

const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 60 minutes

export async function generateAndStoreSignals() {
  const symbols: Symbol[] = ["BTC", "ETH", "SOL"];
  const results: SignalSnapshot[] = [];

  for (const symbol of symbols) {
    try {
      console.log(`[ENGINE] Processing ${symbol}...`);

      // Fetch candles (only in Cron)
      const [candles4H, candles1H, candles15M] = await Promise.all([
        getCandles4H(symbol),
        getCandles15M(symbol),
        getCandles5M(symbol),
      ]);

      // Generate signal
      const signal = generateSignal(symbol, candles4H, candles1H, candles15M);

      // Map old state to new state (WAIT→WATCHING_SHIFT, WATCH→BUILDING, LONG/SHORT→SNIPER)
      let newState = "WATCHING_SHIFT";
      if (signal.state === "WATCH") {
        newState = "BUILDING";
      } else if (signal.state === "LONG" || signal.state === "SHORT") {
        newState = "SNIPER";
      }

      // Validate state
      const validatedState = validateState(newState);

      // Detect transition
      const transition = await detectTransition(symbol, validatedState);

      // Alert only on transition to SNIPER
      if (transition.isSniperEntry) {
        const cooldown = await getTelegramCooldown(symbol);
        const now = Date.now();
        const lastAlertTime = cooldown ? new Date(cooldown.lastAlertAt).getTime() : 0;
        const canAlert = now - lastAlertTime >= ALERT_COOLDOWN_MS;

        if (canAlert) {
          console.log(`[ENGINE] Sending Telegram alert for ${symbol} SNIPER`);

          // Map to telegram-friendly state
          const telegramState =
            signal.state === "LONG" ? "LONG" : signal.state === "SHORT" ? "SHORT" : "UNKNOWN";

          const sent = await sendTelegramAlert({
            ...signal,
            state: telegramState as any, // Telegram still uses old names
          });

          if (sent) {
            const now_iso = new Date().toISOString();
            await updateTelegramCooldown(symbol, now_iso);
            await recordAlert({
              symbol,
              state: validatedState,
              timestamp: now_iso,
              alertSent: true,
            });
          }
        } else {
          const minutesUntilNext = Math.ceil(
            (ALERT_COOLDOWN_MS - (now - lastAlertTime)) / 60000
          );
          console.log(
            `[ENGINE] ${symbol} SNIPER alert in cooldown (${minutesUntilNext}m remaining)`
          );
        }
      }

      // Store signal snapshot
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
        `[ENGINE] ${symbol}: ${transition.fromState} → ${validatedState} (confidence: ${signal.confidence}%)`
      );
    } catch (err) {
      console.error(`[ENGINE] Error processing ${symbol}:`, err);
    }
  }

  return results;
}
