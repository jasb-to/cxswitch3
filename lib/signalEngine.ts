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
   MAIN ENGINE LOOP
========================= */

export async function generateAndStoreSignals() {
  const symbols: Symbol[] = ["BTC", "ETH", "SOL"];

  console.log(`\n[ENGINE] ===============================`);
  console.log(`[ENGINE] EARLY ENTRY SCAN START`);
  console.log(`[ENGINE] ===============================\n`);

  for (const symbol of symbols) {
    try {
      console.log(`\n[ENGINE] ===== ${symbol} =====`);

      /* =========================
         FETCH DATA
      ========================= */

      const [c4, c15, c5, price] = await Promise.all([
        getCandles4H(symbol),
        getCandles15M(symbol),
        getCandles5M(symbol),
        getCurrentPrice(symbol),
      ]);

      if (!c4?.length || !c15?.length || !c5?.length) {
        console.log(`[ENGINE] ${symbol}: missing candle data`);
        continue;
      }

      if (!price || price <= 0) {
        console.log(`[ENGINE] ${symbol}: invalid price`);
        continue;
      }

      /* =========================
         SIGNAL GENERATION
      ========================= */

      const signal = generateSignal(symbol, c4, c15, c5, price);

      console.log(
        `[ENGINE] ${symbol}: ${signal.reason} | $${signal.price.toFixed(2)}`
      );

      /* =========================
         TELEGRAM LOGIC (ONLY EARLY ENTRIES)
      ========================= */

      if (signal.isSniper) {
        const cooldown = await getTelegramCooldown(symbol);

        const now = Date.now();
        const last = cooldown
          ? new Date(cooldown.lastAlertAt).getTime()
          : 0;

        const canSend = now - last > ALERT_COOLDOWN_MS;

        if (canSend) {
          const sent = await sendTelegramAlert(signal);

          if (sent) {
            await updateTelegramCooldown(symbol, new Date().toISOString());
            console.log(`[ENGINE] ${symbol}: 🚨 EARLY ENTRY ALERT SENT`);
          } else {
            console.log(`[ENGINE] ${symbol}: alert failed`);
          }
        } else {
          console.log(`[ENGINE] ${symbol}: cooldown active`);
        }
      } else if (signal.isSniperCandidate) {
        console.log(`[ENGINE] ${symbol}: 🟡 early breakout forming`);
      } else if (signal.isSetupValid) {
        console.log(`[ENGINE] ${symbol}: 🟠 compression zone detected`);
      } else {
        console.log(`[ENGINE] ${symbol}: waiting`);
      }

      /* =========================
         STORE SNAPSHOT
      ========================= */

      await storeSignalSnapshot(signal);
    } catch (err) {
      console.error(`[ENGINE ERROR] ${symbol}`, err);
    }
  }

  console.log(`\n[ENGINE] ===============================`);
  console.log(`[ENGINE] SCAN COMPLETE`);
  console.log(`[ENGINE] ===============================\n`);
}
