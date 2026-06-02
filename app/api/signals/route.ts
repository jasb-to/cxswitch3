import { getLivePrices } from "@/lib/prices";

export const runtime = "nodejs";

function getState(price: number) {
  const compression = (price % 100) / 100;
  const momentum = (price % 17) / 17;

  if (compression < 0.35 && momentum < 0.5) return "EARLY";
  if (compression > 0.75 && momentum > 0.6) return "SNIPER";
  return "WAIT";
}

export async function GET() {
  const prices = await getLivePrices();

  const signals = Object.entries(prices).map(([symbol, price]) => {
    return {
      symbol,
      price,
      state: getState(price),
    };
  });

  return Response.json({ signals });
}
