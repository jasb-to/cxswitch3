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

/**
 * ENGINE DESIGN:
 * - 4H = bias (directional context)
 * - 15M = structure + trigger
 * - 5M = micro confirmation (entry timing)
 *
 * GOAL:
 * Catch EARLY moves, not late confirmations.
 */

export async function generateAndStoreSignals() {
  const symbols: Symbol[] = ["BTC", "ETH", "SOL"];

  console.log(`[ENGINE] Starting signal cycle...`);

  for (const symbol of symbols) {
    try {
      console.log(`\n[ENGINE] ===== ${symbol} =====`);

      /* =========================
         FETCH MARKET DATA
      ========================= */

      const [c4, c15, c5, price] = await Promise.all([
        getCandles4H(symbol),
        getCandles15M(symbol),
        getCandles5M(symbol),
        getCurrentPrice(symbol),
      ]);

      if (!price || price <= 0) {
        console.warn(`[ENGINE] ${symbol}: invalid price`);
        continue;
      }

      if (!c4?.length || !c15?.length || !c5?.length) {
        console.warn(`[ENGINE] ${symbol}: missing candle data`);
        continue;
      }

      /* =========================
         GENERATE SIGNAL
      ========================= */

      const signal = generateSignal(symbol, c4, c15, c5, price);

      // Safety defaults (prevents UI crashes + NaNs)
      signal.stopLoss = signal.stopLoss ?? null;
      signal.takeProfit = signal.takeProfit ?? null;
      signal.riskRewardRatio = signal.riskRewardRatio ?? null;

      console.log(
        `[ENGINE] ${symbol}: ${signal.reason} | price=${signal.price} | ADX=${signal.adx}`
      );

      /* =========================
         EARLY ENTRY LOGIC
      =========================
      We do NOT require perfect setup anymore.
      We classify into:
      - EARLY_BIAS (trend forming)
      - SETUP (valid structure)
      - SNIPER (trigger hit)
      */

      const isEarlyBias =
        signal.adx > 12 && signal.adx < 25; // early trend formation window

      const isSetup = signal.isSetupValid;
      const isEntryWindow = signal.isSniperCandidate;

      /* =========================
         TELEGRAM ALERT LOGIC
      ========================= */

      const cooldown = await getTelegramCooldown(symbol);
      const now = Date.now();
      const last = cooldown ? new Date(cooldown.lastAlertAt).getTime() : 0;
      const canAlert = now - last >= ALERT_COOLDOWN_MS;

      if (signal.isSniper && canAlert) {
        const sent = await sendTelegramAlert(signal);

        if (sent) {
          await updateTelegramCooldown(symbol, new Date().toISOString());
          console.log(`[ENGINE] ${symbol}: 🟢 SNIPER ALERT SENT`);
        } else {
          console.log(`[ENGINE] ${symbol}: alert failed`);
        }
      }

      /* =========================
         LOG STATE (IMPORTANT FOR DEBUGGING)
      ========================= */

      if (signal.isSniper) {
        console.log(`[ENGINE] ${symbol}: 🟢 SNIPER`);
      } else if (isSetup) {
        console.log(`[ENGINE] ${symbol}: 🟡 SETUP`);
      } else if (isEarlyBias) {
        console.log(`[ENGINE] ${symbol}: 🔵 EARLY BIAS`);
      } else {
        console.log(`[ENGINE] ${symbol}: ⚪ NO SETUP`);
      }

      /* =========================
         STORE SNAPSHOT
      ========================= */

      await storeSignalSnapshot(signal);
    } catch (err) {
      console.error(`[ENGINE ERROR] ${symbol}:`, err);
    }
  }

  console.log(`[ENGINE] COMPLETE`);
}
