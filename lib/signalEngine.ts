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

export async function generateAndStoreSignals() {
  const symbols: Symbol[] = ["BTC", "ETH", "SOL"];

  for (const symbol of symbols) {
    try {
      const [c4, c1, c15] = await Promise.all([
        getCandles4H(symbol),
        getCandles15M(symbol),
        getCandles5M(symbol),
      ]);

      const price = await getCurrentPrice(symbol);

      const signal = generateSignal(symbol, c4, c1, c15, price);

      if (signal.isSniper) {
        if (isSetupConsumed(signal.setupId)) {
          console.log(`[ENGINE] ${symbol}: setup consumed`);
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

              console.log(`[ENGINE] ${symbol}: SNIPER SENT`);
            }
          }
        }
      }

      await storeSignalSnapshot({
        ...signal,
      });

      console.log(
        `[ENGINE] ${symbol}: ${signal.reason} | ${signal.price}`
      );
    } catch (e) {
      console.error(`[ENGINE ERROR] ${symbol}`, e);
    }
  }
}
