import { getLivePrices } from "@/lib/prices";

export const runtime = "nodejs";

function detectState(price: number, symbol: string) {
  // deterministic but based on REAL PRICE

  const base = price;

  const compression = (base % 100) / 100;
  const momentum = (base % 17) / 17;

  if (compression < 0.35 && momentum < 0.5) {
    return "EARLY";
  }

  if (compression > 0.75 && momentum > 0.6) {
    return "SNIPER";
  }

  return "WAIT";
}

export async function GET() {
  const prices = await getLivePrices();

  const signals = Object.entries(prices).map(([symbol, price]) => {
    const state = detectState(price, symbol);

    return {
      symbol,
      price,
      state,
    };
  });

  return Response.json({ signals });
}
