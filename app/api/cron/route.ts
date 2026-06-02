import { generateSignal } from "@/lib/signalEngine";
import { processAlerts } from "@/lib/alertEngine";
import { getLivePrices } from "@/lib/prices";

export const runtime = "nodejs";

export async function GET() {
  const prices = await getLivePrices();

  const symbols = ["BTC", "ETH", "SOL"];

  const signals = symbols.map((s) =>
    generateSignal(s, prices[s])
  );

  console.log("[CRON] signals:", signals);

  await processAlerts(signals);

  return Response.json({
    ok: true,
    signals,
  });
}
