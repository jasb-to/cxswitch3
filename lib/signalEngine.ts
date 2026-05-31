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

  for (const symbol of symbols) {
    try {
      console.log(`\n[ENGINE] ===== ${symbol} =====`);

      /* =========================
         FETCH DATA
      ========================= */

      const [c4, c1, c15] = await Promise.all([
        getCandles4H(symbol),
        getCandles15M(symbol),
        getCandles5M(symbol),
      ]);

      const price = await getCurrentPrice(symbol);

      const signal = generateSignal(symbol, c4, c1, c15, price);

      /* =========================
         SNIPER LOGIC ONLY
      ========================= */

      if (signal.isSniper) {
        const alreadyUsed = isSetupConsumed(signal.setupId);

        if (alreadyUsed) {
          console.log(`[ENGINE] ${symbol}: setup already consumed`);
        } else {
          const cooldown = await getTelegramCooldown(symbol);

          const now = Date.now();
          const last = cooldown
            ? new Date(cooldown.lastAlertAt).getTime()
            : 0;

          if (now - last > ALERT_COOLDOWN_MS) {
            const sent = await sendTelegramAlert(signal);

            if (sent) {
              updateTelegramCooldown(symbol, new Date().toISOString());
              markSetupConsumed(signal.setupId);

              console.log(`[ENGINE] ${symbol}: SNIPER SENT + LOCKED`);
            } else {
              console.log(`[ENGINE] ${symbol}: alert failed`);
            }
          } else {
            console.log(`[ENGINE] ${symbol}: cooldown active`);
          }
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
