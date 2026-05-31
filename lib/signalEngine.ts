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
  SignalSnapshot,
} from "./persistence";

import { sendTelegramAlert } from "./telegram";

const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

/* =========================
   MAIN ENGINE
========================= */

export async function generateAndStoreSignals() {
  const symbols: Symbol[] = ["BTC", "ETH", "SOL"];

  const results: SignalSnapshot[] = [];

  for (const symbol of symbols) {
    try {
      console.log(`\n[ENGINE] ===== ${symbol} =====`);

      /* =========================
         STEP 1: FETCH DATA
      ========================= */

      const [candles4H, candles1H, candles15M] = await Promise.all([
        getCandles4H(symbol),
        getCandles15M(symbol),
        getCandles5M(symbol),
      ]);

      if (!candles4H?.length || !candles1H?.length || !candles15M?.length) {
        throw new Error(`Missing candle data for ${symbol}`);
      }

      /* =========================
         STEP 2: LIVE PRICE
      ========================= */

      const livePrice = await getCurrentPrice(symbol);

      if (!livePrice) {
        throw new Error(`Invalid live price for ${symbol}`);
      }

      console.log(`[ENGINE] ${symbol} price: $${livePrice.toFixed(2)}`);

      /* =========================
         STEP 3: GENERATE SIGNAL
      ========================= */

      const signal = generateSignal(
        symbol,
        candles4H,
        candles1H,
        candles15M,
        livePrice
      );

      /* =========================
         STEP 4: ACTION ONLY (NO LOGIC BRANCHING)
      ========================= */

      if (signal.isSniper) {
        console.log(`[ENGINE] ${symbol}: SNIPER SIGNAL`);

        const cooldown = await getTelegramCooldown(symbol);

        const now = Date.now();
        const last = cooldown
          ? new Date(cooldown.lastAlertAt).getTime()
          : 0;

        const canSend = now - last >= ALERT_COOLDOWN_MS;

        if (canSend) {
          console.log(`[ENGINE] ${symbol}: sending alert`);

          const sent = await sendTelegramAlert(signal);

          if (sent) {
            await updateTelegramCooldown(
              symbol,
              new Date().toISOString()
            );

            console.log(`[ENGINE] ${symbol}: alert sent`);
          } else {
            console.warn(`[ENGINE] ${symbol}: alert failed`);
          }
        } else {
          const mins = Math.ceil(
            (ALERT_COOLDOWN_MS - (now - last)) / 60000
          );

          console.log(
            `[ENGINE] ${symbol}: cooldown active (${mins} min left)`
          );
        }
      } else {
        // IMPORTANT: no interpretation, just passive logging
        console.log(`[ENGINE] ${symbol}: no sniper signal`);
      }

      /* =========================
         STEP 5: STORE SNAPSHOT
      ========================= */

      const snapshot: SignalSnapshot = {
        symbol,
        isSetupValid: signal.isSetupValid,
        isSniperCandidate: signal.isSniperCandidate,
        isSniper: signal.isSniper,
        confidence: signal.confidence,
        price: signal.price,
        adx: signal.adx,
        stochK: signal.stochK,
        stochD: signal.stochD,
        bias: signal.bias,
        reason: signal.reason,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        riskRewardRatio: signal.riskRewardRatio,
        updatedAt: signal.updatedAt,
      };

      await storeSignalSnapshot(snapshot);
      results.push(snapshot);

      /* =========================
         CLEAN OUTPUT
      ========================= */

      console.log(`[ENGINE OUTPUT] ${symbol}`);
      console.log(`  sniper=${snapshot.isSniper}`);
      console.log(`  setup=${snapshot.isSetupValid}`);
      console.log(`  price=$${snapshot.price.toFixed(2)}`);
      console.log(`  bias=${snapshot.bias}`);
      console.log(`  confidence=${snapshot.confidence}`);
      console.log(`  reason=${snapshot.reason}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ENGINE ERROR] ${symbol}: ${msg}`);
    }
  }

  console.log(`\n[ENGINE] COMPLETE`);

  return results;
}
