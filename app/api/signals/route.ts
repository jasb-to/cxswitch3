import { getLivePrices } from "@/lib/prices";

export const runtime = "nodejs";

function computeSignal(symbol: string, price: number) {
  const seed = price % 1000;

  const compression = (seed % 100) / 100;
  const momentum = (seed % 37) / 37;

  let state: "EARLY" | "SNIPER" | "WAIT" = "WAIT";

  if (compression < 0.35 && momentum < 0.5) state = "EARLY";
  if (compression > 0.75 && momentum > 0.6) state = "SNIPER";

  const bias =
    momentum > 0.55 ? "Bullish" : momentum < 0.4 ? "Bearish" : "Neutral";

  const confidence =
    state === "SNIPER" ? 85 : state === "EARLY" ? 60 : 20;

  const adx = Number((20 + momentum * 50).toFixed(1));
  const stoch = Number((momentum * 100).toFixed(1));

  const sl =
    state === "SNIPER"
      ? Number((price * 0.99).toFixed(2))
      : null;

  const tp =
    state === "SNIPER"
      ? Number((price * 1.02).toFixed(2))
      : null;

  return {
    symbol,
    price: Number(price.toFixed(2)),
    state,
    bias,
    confidence,
    adx,
    stoch,
    stopLoss: sl,
    takeProfit: tp,
  };
}

export async function GET() {
  const prices = await getLivePrices();

  const signals = Object.entries(prices).map(([symbol, price]) =>
    computeSignal(symbol, price)
  );

  return Response.json({ signals });
}
