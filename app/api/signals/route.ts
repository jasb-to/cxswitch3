import { getPrices } from "@/lib/prices";
import { generateSignal } from "@/lib/signalEngine";

export const runtime = "nodejs";

export async function GET() {
  const prices = await getPrices();

  const signals = Object.entries(prices).map(([symbol, price]) =>
    generateSignal(symbol, price)
  );

  return Response.json({
    signals,
    updatedAt: new Date().toISOString(),
  });
}
