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
   MAIN ENGINE LOOP
========================= */

export async function generateAndStoreSignals() {
  const symbols: Symbol[] = ["BTC", "ETH", "SOL"];

  console.log(`[ENGINE] Starting cycle...`);

  for (const symbol of symbols) {
    try {
      console.log(`\n[ENGINE] ===== ${symbol} =====`);

      /* =========================
         FETCH MARKET DATA
      ========================= */

      const [candles4H, candles1H, candles15M] = await Promise.all([
        getCandles4H(symbol),
        getCandles15M(symbol),
        getCandles5M(symbol),
      ]);

      if (!candles4H?.length || !candles1H?.length || !candles15M?.length) {
        throw new Error("Missing candle data");
      }

      const price = await getCurrentPrice(symbol);

      if (!price) {
        throw new Error("Invalid price");
      }

      /* =========================
         GENERATE SIGNAL
      ========================= */

      const signal = generateSignal(
        symbol,
        candles4H,
        candles1H,
        candles15M,
        price
      );

      /* =========================
         SNIPER EXECUTION ONLY
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

          const canSendAlert =
            now - lastAlert >= ALERT_COOLDOWN_MS;

          if (!canSendAlert) {
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
         SNAPSHOT STORAGE
      ========================= */

      await storeSignalSnapshot(signal);

      /* =========================
         CLEAN OUTPUT
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
