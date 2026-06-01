import { generateAndStoreSignals } from "@/lib/signalEngine";
import {
  getCandles4H,
  getCandles15M,
  getCurrentPrice,
} from "@/lib/kraken";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const secret = new URL(request.url).searchParams.get("secret");

  if (secret !== "abc123xyz789") {
    return Response.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const startTime = Date.now();

  console.log(
    "[CRON] ════════════════════════════════════════════════════════════"
  );
  console.log(`[CRON] STARTED at ${new Date().toLocaleString()}`);
  console.log(
    "[CRON] ════════════════════════════════════════════════════════════"
  );

  try {
    const symbols = ["BTC", "ETH", "SOL"] as const;

    const inputs = await Promise.all(
      symbols.map(async (symbol) => ({
        symbol,

        candles4H: await getCandles4H(symbol),

        candles1H: [],

        candles15M: await getCandles15M(symbol),

        price: await getCurrentPrice(symbol),
      }))
    );

    const result = await generateAndStoreSignals(inputs);

    const duration = Date.now() - startTime;

    console.log(
      `[CRON] COMPLETE in ${duration}ms | Signals: ${result.signals.length}`
    );

    return Response.json({
      success: true,
      signalCount: result.signals.length,
      executionTime: duration,
    });
  } catch (err) {
    const duration = Date.now() - startTime;

    console.error(
      `[CRON] FAILED after ${duration}ms`,
      err
    );

    return Response.json(
      {
        success: false,
        error:
          err instanceof Error
            ? err.message
            : "Unknown error",
      },
      { status: 500 }
    );
  }
}
