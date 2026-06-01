import { generateSignal } from "@/lib/signalEngine";
import { storeSignalSnapshot } from "@/lib/persistence";

export const runtime = "nodejs";

export async function GET() {
  try {
    console.log("[CRON] START");

    const symbols = ["BTC", "ETH", "SOL"];

    const results = [];

    for (const symbol of symbols) {
      // fake price feed placeholder (replace with real feed later)
      const price =
        symbol === "BTC"
          ? 70000 + Math.random() * 2000
          : symbol === "ETH"
          ? 1900 + Math.random() * 200
          : 80 + Math.random() * 10;

      const signal = generateSignal(
        symbol as any,
        [],
        [],
        [],
        price
      );

      console.log("[CRON SIGNAL]", signal);

      await storeSignalSnapshot(signal);

      results.push(signal);
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
