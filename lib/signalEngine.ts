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

type EngineState = "EARLY" | "SETUP" | "SNIPER" | "NONE";

export async function generateAndStoreSignals() {
  const symbols: Symbol[] = ["BTC", "ETH", "SOL"];

  for (const symbol of symbols) {
    try {
      console.log(`\n[ENGINE] ===== ${symbol} =====`);

      const [c4, c15, c5] = await Promise.all([
        getCandles4H(symbol),
        getCandles15M(symbol),
        getCandles5M(symbol),
      ]);

      if (!c4.length || !c15.length || !c5.length) {
        console.warn(`[ENGINE] ${symbol}: missing candle data`);
        continue;
      }

      const price = await getCurrentPrice(symbol);

      if (!price || price <= 0) {
        console.warn(`[ENGINE] ${symbol}: invalid price`);
        continue;
      }

      const signal = generateSignal(symbol, c4, c15, c5, price);

      const state = deriveEngineState(signal);

      const enriched = {
        ...signal,
        engineState: state,
      };

      /* =========================
         TELEGRAM ONLY ON REAL BREAKOUT
      ========================= */

      if (state === "SNIPER") {
        const cooldown = await getTelegramCooldown(symbol);

        const now = Date.now();
        const last = cooldown
          ? new Date(cooldown.lastAlertAt).getTime()
          : 0;

        const canSend = now - last > ALERT_COOLDOWN_MS;

        if (canSend) {
          const sent = await sendTelegramAlert(enriched as any);

          if (sent) {
            await updateTelegramCooldown(symbol, new Date().toISOString());
            console.log(`[ENGINE] ${symbol}: SNIPER ALERT SENT`);
          }
        } else {
          console.log(`[ENGINE] ${symbol}: cooldown active`);
        }
      }

      /* =========================
         LOGGING
      ========================= */

      console.log(
        `[ENGINE] ${symbol}: ${state} | ${signal.reason} | $${signal.price}`
      );

      await storeSignalSnapshot(enriched as any);
    } catch (err) {
      console.error(`[ENGINE ERROR] ${symbol}`, err);
    }
  }

  console.log(`[ENGINE] COMPLETE`);
}

/* =========================
   ENGINE STATE LOGIC v2
   (LESS NOISE, MORE STRUCTURE)
========================= */

function deriveEngineState(signal: any): EngineState {
  const { isSetupValid, isSniper, adx, stochK, bias } = signal;

  // 1. SNIPER = breakout confirmed
  if (isSniper) return "SNIPER";

  // 2. SETUP = structure + momentum alignment
  if (isSetupValid && adx > 18) return "SETUP";

  // 3. EARLY = ONLY meaningful compression + directional bias
  const early =
    adx > 12 &&
    bias !== "Neutral" &&
    ((bias === "Bullish" && stochK < 50) ||
      (bias === "Bearish" && stochK > 50));

  if (early) return "EARLY";

  return "NONE";
}
