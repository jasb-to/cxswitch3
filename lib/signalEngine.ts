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

export async function generateAndStoreSignals() {
  const symbols: Symbol[] = ["BTC", "ETH", "SOL"];

  for (const symbol of symbols) {
    try {
      console.log(`\n[ENGINE] ===== ${symbol} =====`);

      /* =========================
         FETCH DATA
      ========================= */

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
         TELEGRAM LOGIC
      ========================= */

      if (signal.isSniper) {
        const cooldown = await getTelegramCooldown(symbol);

        const now = Date.now();
        const last = cooldown
          ? new Date(cooldown.lastAlertAt).getTime()
          : 0;

        const canSend = now - last >= ALERT_COOLDOWN_MS;

        if (canSend) {
          const sent = await sendTelegramAlert(signal);

          if (sent) {
            await updateTelegramCooldown(symbol, new Date().toISOString());
            console.log(`[ENGINE] ${symbol}: SNIPER ALERT SENT`);
          } else {
            console.log(`[ENGINE] ${symbol}: alert failed`);
          }
        } else {
          console.log(`[ENGINE] ${symbol}: cooldown active`);
        }
      } else if (signal.isSetupValid) {
        console.log(`[ENGINE] ${symbol}: setup valid (waiting)`);
      } else {
        console.log(`[ENGINE] ${symbol}: no setup`);
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
