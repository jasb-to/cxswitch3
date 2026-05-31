import {
  getCandles4H,
  getCandles15M,
  getCandles5M,
  getCurrentPrice,
} from "./kraken";

import { generateSignal, Symbol, Signal } from "./strategy";

import {
  storeSignalSnapshot,
  getTelegramCooldown,
  updateTelegramCooldown,
} from "./persistence";

import { sendTelegramAlert } from "./telegram";

/* =========================
   STATE MACHINE
========================= */

type SignalState =
  | "EARLY"
  | "SETUP"
  | "ARMED"
  | "SNIPER"
  | "INVALIDATED"
  | "WAIT";

interface EngineMemory {
  lastState: Record<string, SignalState>;
  lastSetupId: Record<string, string>;
}

const memory: EngineMemory = {
  lastState: {},
  lastSetupId: {},
};

const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

/* =========================
   STATE RESOLVER
========================= */

function resolveState(signal: Signal): SignalState {
  const trigger =
    signal.stochK < 30 || signal.stochK > 70;

  if (signal.isSniper) return "SNIPER";
  if (signal.isSetupValid && trigger) return "ARMED";
  if (signal.isSetupValid) return "SETUP";
  if (signal.adx > 18 && signal.bias !== "Neutral") return "EARLY";
  return "WAIT";
}

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

      const [c4, c15, c5, price] = await Promise.all([
        getCandles4H(symbol),
        getCandles15M(symbol),
        getCandles5M(symbol),
        getCurrentPrice(symbol),
      ]);

      if (!c4?.length || !c15?.length || !c5?.length || !price) {
        throw new Error(`Missing data for ${symbol}`);
      }

      /* =========================
         GENERATE SIGNAL
      ========================= */

      const signal = generateSignal(symbol, c4, c15, c5, price);

      const state = resolveState(signal);
      const prevState = memory.lastState[symbol];

      const setupChanged =
        memory.lastSetupId[symbol] !== signal.setupId;

      const stateChanged = prevState !== state;

      memory.lastState[symbol] = state;
      memory.lastSetupId[symbol] = signal.setupId;

      /* =========================
         LOGIC DECISION
      ========================= */

      console.log(
        `[ENGINE] ${symbol}: ${prevState || "INIT"} → ${state}`
      );

      let shouldAlert = false;

      if (state === "SNIPER") {
        shouldAlert = stateChanged || setupChanged;
      }

      if (state === "ARMED") {
        shouldAlert = stateChanged;
      }

      if (state === "EARLY") {
        shouldAlert = stateChanged && setupChanged;
      }

      /* =========================
         TELEGRAM
      ========================= */

      if (shouldAlert) {
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
            console.log(`[ENGINE] ${symbol}: ALERT SENT (${state})`);
          }
        } else {
          console.log(`[ENGINE] ${symbol}: cooldown active`);
        }
      }

      /* =========================
         SNAPSHOT STORAGE
      ========================= */

      await storeSignalSnapshot({
        ...signal,
        reason: state,
      });

      console.log(
        `[ENGINE] ${symbol}: ${state} | $${signal.price}`
      );
    } catch (err) {
      console.error(`[ENGINE ERROR] ${symbol}`, err);
    }
  }

  console.log(`[ENGINE] COMPLETE`);
}
