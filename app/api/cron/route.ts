import { getLivePrices } from "@/lib/prices";
import { generateSignal } from "@/lib/signalEngine";
import { storeSignalSnapshot } from "@/lib/persistence";
import { processAlerts } from "@/lib/alertEngine";

export const runtime = "nodejs";

export async function GET() {
  try {
    const prices = await getLivePrices();

    const symbols = ["BTC", "ETH", "SOL"];

    const signals = [];

    for (const symbol of symbols) {
      const price = prices[symbol as keyof typeof prices];

      const signal = generateSignal(symbol, price);

      const full = { ...signal, price };

      signals.push(full);

      await storeSignalSnapshot(full);

      console.log(
        `[CRON] ${symbol} ${signal.state} @ ${price}`
      );
    }

    // ⚠️ IMPORTANT: MUST AWAIT ALERTS
    await processAlerts(signals);

    return Response.json({
      ok: true,
      signalsCount: signals.length,
    });
  } catch (err) {
    console.error("[CRON ERROR]", err);

    return Response.json({ ok: false }, { status: 500 });
  }
}
