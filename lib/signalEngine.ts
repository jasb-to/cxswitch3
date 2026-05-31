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
   ENGINE
========================= */

export async function generateAndStoreSignals() {
  const symbols: Symbol[] = ["BTC", "ETH", "SOL"];

  for (const symbol of symbols) {
    try {
      console.log(`\n[ENGINE] ===== ${symbol} =====`);

      /* FETCH DATA */
      const [c4, c15, c5] = await Promise.all([
        getCandles4H(symbol),
        getCandles15M(symbol),
        getCandles5M(symbol),
      ]);

      if (!c4?.length || !c15?.length || !c5?.length) {
        throw new Error(`Missing candle data for ${symbol}`);
      }

      const price = await getCurrentPrice(symbol);

      if (!price) {
        throw new Error(`Invalid price for ${symbol}`);
      }

      const signal = generateSignal(symbol, c4, c15, c5, price);

      /* =========================
         ALERT LOGIC (STRICTLY ALIGNED)
      ========================= */

      let shouldAlert = false;
      let alertType: "ENTRY" | "CONTINUATION" | "NONE" = "NONE";

      // 🟡 ENTRY (SETUP = YOUR REAL TRADE)
      if (signal.stage === "SETUP" && signal.confidence >= 60) {
        shouldAlert = true;
        alertType = "ENTRY";
      }

      // 🟢 SNIPER = optional follow-through alerts (low frequency)
      if (signal.stage === "SNIPER" && signal.confidence >= 65) {
        shouldAlert = true;
        alertType = "CONTINUATION";
      }

      /* =========================
         TELEGRAM COOLDOWN
      ========================= */

      if (shouldAlert) {
        const cooldown = await getTelegramCooldown(symbol);

        const now = Date.now();
        const last = cooldown
          ? new Date(cooldown.lastAlertAt).getTime()
          : 0;

        const canSend = now - last >= ALERT_COOLDOWN_MS;

        if (canSend) {
          const sent = await sendTelegramAlert({
            ...signal,
            reason:
              alertType === "ENTRY"
                ? "ENTRY SIGNAL (SETUP)"
                : "CONTINUATION (SNIPER)",
          });

          if (sent) {
            await updateTelegramCooldown(symbol, new Date().toISOString());
            console.log(
              `[ENGINE] ${symbol}: ${alertType} ALERT SENT (${signal.stage})`
            );
          }
        } else {
          console.log(`[ENGINE] ${symbol}: cooldown active`);
        }
      } else {
        console.log(
          `[ENGINE] ${symbol}: ${signal.stage} | no alert`
        );
      }

      /* STORE SNAPSHOT */
      await storeSignalSnapshot(signal);

      console.log(
        `[ENGINE] ${symbol}: ${signal.stage} | $${signal.price}`
      );
    } catch (err) {
      console.error(`[ENGINE ERROR] ${symbol}`, err);
    }
  }

  console.log(`[ENGINE] COMPLETE`);
}
