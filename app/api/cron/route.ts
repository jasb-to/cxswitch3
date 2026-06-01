import { generateSignal } from "@/lib/signalEngine";
import { processAlerts } from "@/lib/alertEngine";

export const runtime = "nodejs";

const symbols = ["BTC", "ETH", "SOL"];

const prices: Record<string, number> = {
  BTC: 71000,
  ETH: 2000,
  SOL: 80,
};

export async function GET() {
  try {
    const signals = symbols.map((s) =>
      generateSignal(s, prices[s])
    );

    console.log("[CRON] Generated signals");

    await processAlerts(signals);

    return Response.json({
      ok: true,
      signalsCount: signals.length,
    });
  } catch (e: any) {
    console.error("[CRON ERROR]", e);
    return Response.json({ ok: false });
  }
}
