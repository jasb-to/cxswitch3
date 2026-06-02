import { getLivePrices } from "@/lib/prices";
import { generateSignal, Symbol } from "@/lib/signalEngine";
import { setSignals } from "@/lib/state";
import { sendTelegram } from "@/lib/telegram";

export const runtime = "nodejs";

let lastSnapshot: string | null = null;

export async function GET() {
  try {
    const prices = await getLivePrices();

    const symbols = Object.keys(prices) as Symbol[];

    const signals = symbols.map((symbol) =>
      generateSignal(symbol, prices[symbol])
    );

    setSignals(signals);

    const snapshot = JSON.stringify(signals);

    // prevent spam
    if (snapshot !== lastSnapshot) {
      lastSnapshot = snapshot;

      const sniper = signals.filter((s) => s.state === "SNIPER");

      if (sniper.length) {
        await sendTelegram(
          sniper
            .map(
              (s) =>
                `🔥 ${s.state} ${s.symbol} @ ${s.price} (TP:${s.takeProfit} SL:${s.stopLoss})`
            )
            .join("\n")
        );
      }
    }

    console.log("[CRON] updated signals");

    return Response.json({
      ok: true,
      count: signals.length,
      updatedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[CRON ERROR]", err);

    return Response.json({
      ok: false,
      error: err?.message || "unknown",
    });
  }
}
