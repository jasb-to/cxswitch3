import { generateSignal, Signal, Symbol } from "@/lib/strategy";
import { getCandles4H, getCandles15M } from "@/lib/kraken";
import { sendTelegramAlert } from "@/lib/telegram";

export const runtime = "nodejs";

// Track previously sent signals to avoid duplicate alerts
const sentSignals = new Map<string, { status: string; timestamp: number }>();
const ALERT_COOLDOWN = 30 * 60 * 1000; // 30 minutes

export async function GET() {
  const startTime = Date.now();
  console.log(`[API] === SIGNALS SCAN STARTED at ${new Date().toLocaleTimeString()} ===`);

  try {
    const symbols: Symbol[] = ["BTC", "ETH", "SOL"];
    const signals: Signal[] = [];

    // Fetch all signals in parallel
    const results = await Promise.all(
      symbols.map(async (symbol) => {
        try {
          console.log(`[API] Fetching candles for ${symbol}...`);
          const [candles4H, candles15M] = await Promise.all([
            getCandles4H(symbol),
            getCandles15M(symbol),
          ]);

          if (candles4H.length === 0 || candles15M.length === 0) {
            console.warn(
              `[API] Missing candle data for ${symbol}: 4H=${candles4H.length}, 15M=${candles15M.length}`
            );
            return null;
          }

          console.log(
            `[API] ${symbol}: Got 4H=${candles4H.length} candles, 15M=${candles15M.length} candles`
          );

          const signal = generateSignal(symbol, candles4H, candles15M);

          // Log signal details
          console.log(
            `[API] ${symbol} signal: status=${signal.status}, price=$${signal.price}, adx=${signal.adx.toFixed(1)}, stoch=${signal.stochK}, confidence=${signal.confidence}%`
          );

          if (signal.status !== "NO_SIGNAL") {
            console.log(
              `[API] ${symbol} ACTIVE TRADE: entry=$${signal.entry}, sl=$${signal.stopLoss}, tp=$${signal.takeProfit}, rr=${signal.riskReward?.toFixed(2)}x`
            );
          } else {
            console.log(
              `[API] ${symbol} waiting: ${signal.reason} | next level=$${signal.nearestSwingLevel} (${signal.distanceToSwing}%)`
            );
          }

          return signal;
        } catch (err) {
          console.error(`[API] Error generating signal for ${symbol}: ${err}`);
          return null;
        }
      })
    );

    results.forEach((signal) => {
      if (!signal) return;

      signals.push(signal);

      // Check if we should send telegram alert
      const lastSent = sentSignals.get(signal.symbol);
      const now = Date.now();

      if (signal.status !== "NO_SIGNAL") {
        const shouldAlert =
          !lastSent || // First time
          lastSent.status !== signal.status || // Direction changed
          now - lastSent.timestamp > ALERT_COOLDOWN; // Cooldown expired

        if (shouldAlert) {
          console.log(
            `[API] Sending Telegram alert for ${signal.symbol} ${signal.status}...`
          );
          sendTelegramAlert(signal).then((success) => {
            if (success) {
              sentSignals.set(signal.symbol, {
                status: signal.status,
                timestamp: now,
              });
              console.log(
                `[API] ✅ Telegram alert sent for ${signal.symbol} ${signal.status}`
              );
            } else {
              console.error(
                `[API] ❌ Failed to send Telegram alert for ${signal.symbol}`
              );
            }
          });
        } else {
          const secondsUntilNext = Math.round(
            (ALERT_COOLDOWN - (now - lastSent.timestamp)) / 1000
          );
          console.log(
            `[API] Alert skipped for ${signal.symbol}: same ${signal.status} within cooldown (${secondsUntilNext}s remaining)`
          );
        }
      }
    });

    const duration = Date.now() - startTime;
    console.log(
      `[API] === SIGNALS SCAN COMPLETE in ${duration}ms | Generated ${signals.length} signals ===`
    );

    return Response.json({ signals, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error(`[API] Fatal error: ${err}`);
    return Response.json(
      { error: "Failed to generate signals", signals: [] },
      { status: 500 }
    );
  }
}
