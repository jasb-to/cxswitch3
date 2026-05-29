import { generateSignal, Signal, Symbol } from "@/lib/strategy";
import { getCandles4H, getCandles15M, getCandles5M } from "@/lib/kraken";
import { sendTelegramAlert } from "@/lib/telegram";

export const runtime = "nodejs";

// Persistent signal tracking via environment variable cache
// This persists across requests within the same instance
const ALERT_COOLDOWN = 60 * 60 * 1000; // 60 minutes cooldown between same signal
let lastAlerts: { [key: string]: { status: string; timestamp: number } } = {};

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
          const [candles4H, candles15M, candles5M] = await Promise.all([
            getCandles4H(symbol),
            getCandles15M(symbol),
            getCandles5M(symbol),
          ]);

          if (candles4H.length === 0 || candles15M.length === 0) {
            console.warn(
              `[API] Missing candle data for ${symbol}: 4H=${candles4H.length}, 15M=${candles15M.length}`
            );
            return null;
          }

          console.log(
            `[API] ${symbol}: Got 4H=${candles4H.length} candles, 15M=${candles15M.length} candles, 5M=${candles5M.length} candles`
          );

          const signal = generateSignal(symbol, candles4H, candles15M, candles5M);

          // Log signal details
          console.log(
            `[API] ${symbol} signal: status=${signal.status}, price=$${signal.price}, adx=${signal.adx.toFixed(1)}, stoch=${signal.stochK}, confidence=${signal.confidence}%, entryType=${signal.entryType || "—"}, volume=${signal.volumeRatio?.toFixed(1)}x`
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
      const key = `${signal.symbol}-${signal.status}`;
      const lastSent = lastAlerts[key];
      const now = Date.now();

      if (signal.status !== "NO_SIGNAL") {
        const shouldAlert =
          !lastSent || // First time
          now - lastSent.timestamp > ALERT_COOLDOWN; // Cooldown expired

        if (shouldAlert) {
          console.log(
            `[API] Sending Telegram alert for ${signal.symbol} ${signal.status}...`
          );
          sendTelegramAlert(signal).then((success) => {
            if (success) {
              lastAlerts[key] = { status: signal.status, timestamp: now };
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

    return Response.json(
      { signals, updatedAt: new Date().toISOString() },
      {
        headers: {
          "Cache-Control": "no-cache, no-store, must-revalidate",
          "Pragma": "no-cache",
          "Expires": "0",
        },
      }
    );
  } catch (err) {
    console.error(`[API] Fatal error: ${err}`);
    return Response.json(
      { error: "Failed to generate signals", signals: [] },
      {
        status: 500,
        headers: {
          "Cache-Control": "no-cache, no-store, must-revalidate",
        },
      }
    );
  }
}
