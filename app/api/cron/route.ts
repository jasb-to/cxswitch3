import { getLivePrices } from "@/lib/prices";
import { generateSignal } from "@/lib/signalEngine";
import { setSignals } from "@/lib/state";

export const runtime = "nodejs";

const symbols = ["BTC", "ETH", "SOL"] as const;

export async function GET() {
  try {
    const prices = await getLivePrices();

    const signals = symbols.map((symbol) =>
      generateSignal(symbol, prices[symbol])
    );

    setSignals(signals);

    console.log("[CRON] signals updated", signals.length);

    return Response.json({
      ok: true,
      count: signals.length,
    });
  } catch (err: any) {
    console.error("[CRON ERROR]", err);

    return Response.json({
      ok: false,
      error: err?.message ?? "unknown error",
    });
  }
}
