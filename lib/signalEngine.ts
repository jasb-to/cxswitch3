import {
  getCandles4H,
  getCandles15M,
  getCandles5M,
  getCurrentPrice,
} from "./kraken";

import { generateSignal, Symbol } from "./strategy";

import {
  storeSignalSnapshot,
  getTelegramCooldown,
  updateTelegramCooldown,
  isSetupConsumed,
  markSetupConsumed,
} from "./persistence";

import { sendTelegramAlert } from "./telegram";

const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

/* =========================
   MAIN ENGINE
========================= */

export async function generateAndStoreSignals() {
  const symbols: Symbol[] = ["BTC", "ETH", "SOL"];

  console.log(`[ENGINE] Starting cycle...`);

  for (const symbol of symbols) {
    try {
      console.log(`\n[ENGINE] ===== ${symbol} =====`);

      /* =========================
         FETCH DATA (SAFE)
      ========================= */

      const [candles4H, candles15M, candles5M] = await Promise.all([
        getCandles4H(symbol),
        getCandles15M(symbol),
        getCandles5M(symbol),
      ]);

      // SAFETY GUARD (prevents .length crash)
      if (!Array.isArray(candles4H) ||
          !Array.isArray(candles15M) ||
          !Array.isArray(candles5M)) {
        throw new Error(`Invalid candle response (undefined or not array)`);
      }

      if (
        candles4H.length < 10 ||
        candles15M.length < 10 ||
        candles5M.length < 10
      ) {
        throw new Error(
          `Insufficient candle data: 4H=${candles4H.length}, 15M=${candles15M.length}, 5M=${candles5M.length}`
        );
      }

      /* =========================
         LIVE PRICE
      ========================= */

      const price = await getCurrentPrice(symbol);

      if (!price || price <= 0) {
        throw new Error(`Invalid live price for ${symbol}`);
      }

      /* =========================
         SIGNAL GENERATION
      ========================= */

      const signal = generateSignal(
        symbol,
        candles4H,
        candles15M, // treated as 1H fallback inside strategy if needed
        candles15M,
        price
      );

      /* =========================
         SNIPER EXECUTION LOGIC
      ========================= */

      if (signal.isSniper) {
        const alreadyConsumed = isSetupConsumed(signal.setupId);

        if (alreadyConsumed) {
          console.log(
            `[ENGINE] ${symbol}: setup already consumed → skipping`
          );
        } else {
          const cooldown = await getTelegramCooldown(symbol);

          const now = Date.now();
          const lastAlert = cooldown
            ? new Date(cooldown.lastAlertAt).getTime()
            : 0;

          const canSend =
            now - lastAlert >= ALERT_COOLDOWN_MS;

          if (!canSend) {
            const mins = Math.ceil(
              (ALERT_COOLDOWN_MS - (now - lastAlert)) / 60000
            );

            console.log(
              `[ENGINE] ${symbol}: cooldown active (${mins}m left)`
            );
          } else {
            const sent = await sendTelegramAlert(signal);

            if (sent) {
              updateTelegramCooldown(
                symbol,
                new Date().toISOString()
              );

              markSetupConsumed(signal.setupId);

              console.log(
                `[ENGINE] ${symbol}: SNIPER SENT + SETUP LOCKED`
              );
            } else {
              console.log(
                `[ENGINE] ${symbol}: alert failed`
              );
            }
          }
        }
      } else {
        console.log(
          `[ENGINE] ${symbol}: no sniper condition`
        );
      }

      /* =========================
         STORE SNAPSHOT
      ========================= */

      await storeSignalSnapshot(signal);

      /* =========================
         OUTPUT
      ========================= */

      console.log(`[ENGINE OUTPUT] ${symbol}`);
      console.log(`  price: $${signal.price}`);
      console.log(`  sniper: ${signal.isSniper}`);
      console.log(`  setup: ${signal.isSetupValid}`);
      console.log(`  bias: ${signal.bias}`);
      console.log(`  confidence: ${signal.confidence}`);
      console.log(`  reason: ${signal.reason}`);
    } catch (err) {
      console.error(
        `[ENGINE ERROR] ${symbol}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  console.log(`\n[ENGINE] COMPLETE`);
}
