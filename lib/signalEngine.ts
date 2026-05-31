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

  const executionLog: {
    symbol: string;
    success: boolean;
    state?: string;
    error?: string;
  }[] = [];

  for (const symbol of symbols) {
    try {
      console.log(`[ENGINE] ===== ${symbol} =====`);

      /* =========================
         STEP 1: DATA FETCH
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

      console.log(
        `[ENGINE] ${symbol}: price=$${livePrice.toFixed(2)}`
      );

      /* =========================
         STEP 3: SIGNAL GENERATION
      ========================= */

      const signal = generateSignal(
        symbol,
        candles4H,
        candles1H,
        candles15M,
        livePrice
      );

      /* =========================
         STEP 4: TELEGRAM ALERT (EVENT ONLY)
      ========================= */

      if (signal.isSniper) {
        console.log(`[ENGINE] ${symbol}: SNIPER EVENT DETECTED`);

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
            `[ENGINE] ${symbol}: cooldown active (${mins}m)`
          );
        }
      } else if (signal.isSetupValid) {
        console.log(
          `[ENGINE] ${symbol}: setup valid (waiting trigger)`
        );
      } else {
        console.log(`[ENGINE] ${symbol}: no setup`);
      }

      /* =========================
         STEP 5: SNAPSHOT STORE
      ========================= */

      const snapshot: SignalSnapshot = {
        symbol,
        isSetupValid: signal.isSetupValid,
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

      validateSnapshot(signal, snapshot, symbol);

      await storeSignalSnapshot(snapshot);

      results.push(snapshot);

      /* =========================
         FINAL OUTPUT LOG
      ========================= */

      console.log(`[ENGINE OUTPUT] ${symbol}`);
      console.log(`  setup=${snapshot.isSetupValid}`);
      console.log(`  sniper=${snapshot.isSniper}`);
      console.log(`  price=$${snapshot.price.toFixed(2)}`);
      console.log(`  adx=${snapshot.adx.toFixed(1)}`);
      console.log(`  stochK=${snapshot.stochK.toFixed(1)}`);
      console.log(`  stochD=${snapshot.stochD.toFixed(1)}`);
      console.log(`  bias=${snapshot.bias}`);
      console.log(`  reason=${snapshot.reason}`);

      executionLog.push({
        symbol,
        success: true,
        state: signal.isSniper
          ? "SNIPER"
          : signal.isSetupValid
          ? "SETUP"
          : "NO_SETUP",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      console.error(`[ENGINE] ERROR ${symbol}: ${msg}`);

      executionLog.push({
        symbol,
        success: false,
        error: msg,
      });
    }
  }

  /* =========================
     SUMMARY
  ========================= */

  const success = executionLog.filter(e => e.success).length;

  console.log(
    `[ENGINE] COMPLETE ${success}/${symbols.length}`
  );

  executionLog.forEach(log => {
    if (log.success) {
      console.log(
        `[ENGINE] ✓ ${log.symbol}: ${log.state}`
      );
    } else {
      console.log(
        `[ENGINE] ✗ ${log.symbol}: ${log.error}`
      );
    }
  });

  return results;
}

/* =========================
   SNAPSHOT VALIDATION
========================= */

function validateSnapshot(
  signal: ReturnType<typeof generateSignal>,
  snapshot: SignalSnapshot,
  symbol: string
) {
  const mismatches: string[] = [];

  if (snapshot.symbol !== signal.symbol)
    mismatches.push("symbol");

  if (snapshot.isSetupValid !== signal.isSetupValid)
    mismatches.push("setup");

  if (snapshot.isSniper !== signal.isSniper)
    mismatches.push("sniper");

  if (snapshot.price !== signal.price)
    mismatches.push("price");

  if (snapshot.bias !== signal.bias)
    mismatches.push("bias");

  if (snapshot.adx !== signal.adx)
    mismatches.push("adx");

  if (snapshot.stochK !== signal.stochK)
    mismatches.push("stochK");

  if (snapshot.stochD !== signal.stochD)
    mismatches.push("stochD");

  if (snapshot.stopLoss !== signal.stopLoss)
    mismatches.push("sl");

  if (snapshot.takeProfit !== signal.takeProfit)
    mismatches.push("tp");

  if (mismatches.length) {
    console.warn(
      `[ENGINE] SNAPSHOT MISMATCH ${symbol}: ${mismatches.join(", ")}`
    );
  } else {
    console.log(`[ENGINE] snapshot OK ${symbol}`);
  }
}
