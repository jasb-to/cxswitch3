import { getLivePrices } from "@/lib/prices";
import { generateSignal } from "@/lib/signalEngine";

export const runtime = "nodejs";

export async function GET() {
  const prices = await getLivePrices();

  const signals = ["BTC", "ETH", "SOL"].map((s) =>
    generateSignal(s, prices[s])
  );

  return Response.json({
    signals,
    updatedAt: new Date().toISOString(),
  });
}
