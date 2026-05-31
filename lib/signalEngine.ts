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

      if (!c4?.length || !c15?.length || !c5?.length) {
        throw new Error(`Missing candle data for ${symbol}`);
      }

      const price = await getCurrentPrice(symbol);

      if (!price) {
        throw new Error(`Invalid price for ${symbol}`);
      }

      const signal = generateSignal(symbol, c4, c15, c5, price);

      // =========================
      // STRUCTURE STATE ENGINE
      // =========================

      const state: EngineState = deriveState(signal);

      const enrichedSignal = {
        ...signal,
        engineState: state,
      };

      // =========================
      // TELEGRAM LOGIC
      // =========================

      if (state === "SNIPER") {
        const cooldown = await getTelegramCooldown(symbol);

        const now = Date.now();
        const last = cooldown
          ? new Date(cooldown.lastAlertAt).getTime()
          : 0;

        const canSend = now - last >= ALERT_COOLDOWN_MS;

        if (canSend) {
          const sent = await sendTelegramAlert(enrichedSignal as any);

          if (sent) {
            await updateTelegramCooldown(symbol, new Date().toISOString());
            console.log(`[ENGINE] ${symbol}: SNIPER ALERT SENT`);
          }
        } else {
          console.log(`[ENGINE] ${symbol}: cooldown active`);
        }
      }

      // =========================
      // LOG STATE
      // =========================

      console.log(
        `[ENGINE] ${symbol}: ${state} | ${signal.reason} | $${signal.price}`
      );

      await storeSignalSnapshot(enrichedSignal as any);
    } catch (err) {
      console.error(`[ENGINE ERROR] ${symbol}`, err);
    }
  }

  console.log(`[ENGINE] COMPLETE`);
}

/* =========================
   EARLY STRUCTURE DETECTION
   THIS IS THE CORE IMPROVEMENT
========================= */

function deriveState(signal: any): EngineState {
  const { adx, stochK, bias, isSetupValid, isSniperCandidate, isSniper } =
    signal;

  // 1. SNIPER = your existing trigger
  if (isSniper) return "SNIPER";

  // 2. SETUP = bias aligned + trend strength building
  if (isSetupValid && adx > 18) return "SETUP";

  // 3. EARLY = structure forming BEFORE confirmation
  const earlyStructure =
    (bias === "Bullish" && adx > 12 && stochK < 45) ||
    (bias === "Bearish" && adx > 12 && stochK > 55);

  if (earlyStructure) return "EARLY";

  return "NONE";
}
