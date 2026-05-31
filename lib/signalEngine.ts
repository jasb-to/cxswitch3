import {
  getCandles4H,
  getCandles15M,
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
   STATE MEMORY (prevents flicker)
========================= */

const lastState = new Map<
  string,
  { early: boolean; sniper: boolean; timestamp: number }
>();

function stabilizeSignal(symbol: string, signal: any) {
  const prev = lastState.get(symbol);

  // prevent flip-flopping between EARLY/SNIPER in consecutive runs
  if (prev) {
    const timeSince = Date.now() - prev.timestamp;

    if (timeSince < 60_000) {
      // lock state briefly for stability window
      signal.isEarly = prev.early;
      signal.isSniper = prev.sniper;
    }
  }

  lastState.set(symbol, {
    early: signal.isEarly,
    sniper: signal.isSniper,
    timestamp: Date.now(),
  });

  return signal;
}

/* =========================
   ENGINE LOOP
========================= */

export async function generateAndStoreSignals() {
  const symbols: Symbol[] = ["BTC", "ETH", "SOL"];

  for (const symbol of symbols) {
    try {
      console.log(`\n[ENGINE] ===== ${symbol} =====`);

      /* =========================
         FETCH DATA
      ========================= */

      const [c4, c15] = await Promise.all([
        getCandles4H(symbol),
        getCandles15M(symbol),
      ]);

      const price = await getCurrentPrice(symbol);

      if (!c4?.length || !c15?.length || !price) {
        throw new Error(`Missing market data for ${symbol}`);
      }

      /* =========================
         SIGNAL GENERATION
      ========================= */

      let signal = generateSignal(symbol, c4, [], c15, price);

      signal = stabilizeSignal(symbol, signal);

      await storeSignalSnapshot(signal);

      console.log(
        `[ENGINE] ${symbol}: ${signal.reason} | $${signal.price}`
      );

      /* =========================
         TELEGRAM LOGIC (SNIPER ONLY)
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
            await updateTelegramCooldown(
              symbol,
              new Date().toISOString()
            );

            console.log(
              `[ENGINE] ${symbol}: SNIPER ALERT SENT`
            );
          } else {
            console.log(`[ENGINE] ${symbol}: alert failed`);
          }
        } else {
          console.log(`[ENGINE] ${symbol}: cooldown active`);
        }
      } else if (signal.isEarly) {
        console.log(`[ENGINE] ${symbol}: EARLY setup only`);
      } else {
        console.log(`[ENGINE] ${symbol}: no setup`);
      }
    } catch (err) {
      console.error(`[ENGINE ERROR] ${symbol}`, err);
    }
  }

  console.log(`[ENGINE] COMPLETE`);
}
