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
} from "./persistence";

import { sendTelegramAlert } from "./telegram";

const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

/* =========================
   MAIN ENGINE
========================= */

export async function generateAndStoreSignals() {
  const symbols: Symbol[] = ["BTC", "ETH", "SOL"];

  for (const symbol of symbols) {
    try {
      console.log(`\n[ENGINE] ===== ${symbol} =====`);

      /* =========================
         FETCH DATA
      ========================= */

      const [candles4H, candles1H, candles15M] = await Promise.all([
        getCandles4H(symbol),
        getCandles15M(symbol),
        getCandles5M(symbol),
      ]);

      const price = await getCurrentPrice(symbol);

      if (
        !candles4H?.length ||
        !candles1H?.length ||
        !candles15M?.length
      ) {
        throw new Error(`Missing candle data for ${symbol}`);
      }

      /* =========================
         SIGNAL GENERATION
      ========================= */

      const signal = generateSignal(
        symbol,
        candles4H,
        candles1H,
        candles15M,
        price
      );

      /* =========================
         TELEGRAM LOGIC (SNIPER ONLY)
      ========================= */

      if (signal.isSniper) {
        console.log(`[ENGINE] ${symbol}: SNIPER DETECTED`);

        const cooldown = await getTelegramCooldown(symbol);

        const now = Date.now();
        const last = cooldown
          ? new Date(cooldown.lastAlertAt).getTime()
          : 0;

        const canSend = now - last >= ALERT_COOLDOWN_MS;

        if (canSend) {
          const sent = await sendTelegramAlert(signal);

          if (sent) {
            await updateTelegramCooldown(
              symbol,
              new Date().toISOString()
            );

            console.log(`[ENGINE] ${symbol}: ALERT SENT`);
          } else {
            console.log(`[ENGINE] ${symbol}: ALERT FAILED`);
          }
        } else {
          const mins = Math.ceil(
            (ALERT_COOLDOWN_MS - (now - last)) / 60000
          );

          console.log(
            `[ENGINE] ${symbol}: cooldown active (${mins}m)`
          );
        }
      }

      /* =========================
         STORE SNAPSHOT
      ========================= */

      await storeSignalSnapshot(signal);

      console.log(
        `[ENGINE] ${symbol}: ${signal.reason} | $${signal.price}`
      );
    } catch (err) {
      console.error(`[ENGINE ERROR] ${symbol}`, err);
    }
  }

  console.log(`[ENGINE] COMPLETE`);
}
