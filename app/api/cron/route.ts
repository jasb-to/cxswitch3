import { generateSignal } from "@/lib/signalEngine";
import { storeSignalSnapshot } from "@/lib/persistence";

export const runtime = "nodejs";

export async function GET() {
  try {
    const symbols = ["BTC", "ETH", "SOL"];

    const results = [];

    for (const symbol of symbols) {
      const price =
        symbol === "BTC"
          ? 71000 + Math.random() * 2000
          : symbol === "ETH"
          ? 1950 + Math.random() * 100
          : 80 + Math.random() * 5;

      const signal = generateSignal(symbol, price);

      await storeSignalSnapshot(signal);

      results.push(signal);

      console.log("[ENGINE]", symbol, signal.state);
    }

    return Response.json({
      success: true,
      signals: results,
    });
  } catch (err) {
    console.error("[CRON ERROR]", err);

    return Response.json(
      { success: false },
      { status: 500 }
    );
  }
}
