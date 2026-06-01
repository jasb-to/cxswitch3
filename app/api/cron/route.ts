import { getLivePrices } from "@/lib/prices";
import { generateSignal } from "@/lib/signalEngine";
import { storeSignalSnapshot } from "@/lib/persistence";

export const runtime = "nodejs";

export async function GET() {
  try {
    const prices = await getLivePrices();

    const symbols = ["BTC", "ETH", "SOL"];

    const signals = [];

    for (const symbol of symbols) {
      const price = prices[symbol as keyof typeof prices];

      const signal = generateSignal(symbol, price);

      await storeSignalSnapshot(signal);

      signals.push({
        ...signal,
        price, // 🔥 FORCE LIVE PRICE INTO OUTPUT
      });

      console.log(
        `[ENGINE] ${symbol} | $${price} | ${signal.state}`
      );
    }

    return Response.json({
      ok: true,
      signalsCount: signals.length,
    });
  } catch (err) {
    console.error("[CRON ERROR]", err);

    return Response.json(
      { ok: false, error: "CRON_FAILED" },
      { status: 500 }
    );
  }
}
