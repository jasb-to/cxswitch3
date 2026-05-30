import { generateSignal, Signal, Symbol } from "@/lib/strategy";
import { getCandles4H, getCandles15M, getCandles5M } from "@/lib/kraken";
import { sendTelegramAlert } from "@/lib/telegram";

export const runtime = "nodejs";

// Persistent signal tracking via environment variable cache
const ALERT_COOLDOWN = 60 * 60 * 1000; // 60 minutes cooldown between same signal
let lastAlerts: { [key: string]: { status: string; timestamp: number } } = {};

export async function GET(request: Request) {
  const secret = new URL(request.url).searchParams.get("secret");
  
  // Accept the request if secret is abc123xyz789
  if (secret !== "abc123xyz789") {
    console.error(`[CRON] Invalid secret: ${secret}`);
    return new Response("Unauthorized", { status: 401 });
  }

  const startTime = Date.now();
  console.log(`[CRON] === CRON JOB TRIGGERED at ${new Date().toLocaleTimeString()} ===`);

  try {
    const symbols: Symbol[] = ["BTC", "ETH", "SOL"];
    const signals: Signal[] = [];

    // Fetch all signals in parallel (same logic as /api/signals but called directly)
    const results = await Promise.all(
      symbols.map(async (symbol) => {
        try {
          console.log(`[CRON] Fetching candles for ${symbol}...`);
          const [candles4H, candles15M, candles5M] = await Promise.all([
            getCandles4H(symbol),
            getCandles15M(symbol),
            getCandles5M(symbol),
          ]);

          if (candles4H.length === 0 || candles15M.length === 0) {
            console.warn(
              `[CRON] Missing candle data for ${symbol}: 4H=${candles4H.length}, 15M=${candles15M.length}`
            );
            return null;
          }

          console.log(
            `[CRON] ${symbol}: Got 4H=${candles4H.length} candles, 15M=${candles15M.length} candles, 5M=${candles5M.length} candles`
          );

          const signal = generateSignal(symbol, candles4H, candles15M, candles5M);

          // Log signal details
          console.log(
            `[CRON] ${symbol} signal: state=${signal.state}, price=$${signal.price}, adx=${signal.adx.toFixed(1)}, stoch=${signal.stochK}, confidence=${signal.confidence}%`
          );

          return signal;
        } catch (err) {
          console.error(`[CRON] Error generating signal for ${symbol}: ${err}`);
          return null;
        }
      })
    );

    results.forEach((signal) => {
      if (!signal) return;

      signals.push(signal);

      // Check if we should send telegram alert - ONLY for LONG or SHORT states
      const key = `${signal.symbol}-${signal.state}`;
      const lastSent = lastAlerts[key];
      const now = Date.now();

      if (signal.state === "LONG" || signal.state === "SHORT") {
        const shouldAlert =
          !lastSent || // First time
          now - lastSent.timestamp > ALERT_COOLDOWN; // Cooldown expired

        if (shouldAlert) {
          console.log(
            `[CRON] Sending Telegram alert for ${signal.symbol} ${signal.state}...`
          );
          sendTelegramAlert(signal).then((success) => {
            if (success) {
              lastAlerts[key] = { status: signal.state, timestamp: now };
              console.log(
                `[CRON] ✅ Telegram alert sent for ${signal.symbol} ${signal.state}`
              );
            } else {
              console.error(
                `[CRON] ❌ Failed to send Telegram alert for ${signal.symbol}`
              );
            }
          });
        } else {
          const secondsUntilNext = Math.round(
            (ALERT_COOLDOWN - (now - lastSent.timestamp)) / 1000
          );
          console.log(
            `[CRON] Alert skipped for ${signal.symbol}: same ${signal.state} within cooldown (${secondsUntilNext}s remaining)`
          );
        }
      }
    });

    const duration = Date.now() - startTime;
    console.log(
      `[CRON] === CRON JOB COMPLETE in ${duration}ms | Generated ${signals.length} signals ===`
    );

    return new Response(
      JSON.stringify({
        success: true,
        message: "Signals generated successfully",
        signalCount: signals.length,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error(`[CRON] Fatal error:`, err);
    return new Response(
      JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
