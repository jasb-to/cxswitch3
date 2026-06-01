import { getLivePrices } from "@/lib/prices";
import { generateSignal } from "@/lib/signalEngine";
import { storeSignalSnapshot } from "@/lib/persistence";
import { detectAlerts } from "@/lib/alertEngine";

export const runtime = "nodejs";

export async function GET() {
  try {
    const prices = await getLivePrices();

    const symbols = ["BTC", "ETH", "SOL"];

    const signals = [];

    for (const symbol of symbols) {
      const price = prices[symbol as keyof typeof prices];

      const signal = generateSignal(symbol, price);

      const fullSignal = {
        ...signal,
        price,
        ...buildTradeLevels(symbol, price, signal.bias),
      };

      await storeSignalSnapshot(fullSignal);

      signals.push(fullSignal);

      console.log(
        `[CRON] ${symbol} | ${signal.state} | $${price} | SL:${fullSignal.stopLoss} TP:${fullSignal.takeProfit}`
      );
    }

    // 🔥 ALERT LAYER
    const alerts = detectAlerts(signals);

    for (const a of alerts) {
      console.log(`[ALERT] ${a.message}`);
    }

    return Response.json({
      ok: true,
      signalsCount: signals.length,
      alertsTriggered: alerts.length,
    });
  } catch (err) {
    console.error("[CRON ERROR]", err);

    return Response.json(
      { ok: false, error: "CRON_FAILED" },
      { status: 500 }
    );
  }
}
