const symbols = ["BTC", "ETH", "SOL"];

const prices: Record<string, number> = {
  BTC: 70000,
  ETH: 2000,
  SOL: 80,
};

function generateSignal(symbol: string, price: number) {
  const rand = Math.random();

  return {
    symbol,
    price,
    state: rand > 0.7 ? "SNIPER" : rand > 0.4 ? "EARLY" : "WAIT",
    bias: "Neutral",
    confidence: 50,
    adx: 20,
    stochK: 50,
    reason: "simple engine",
    stopLoss: price * 0.98,
    takeProfit: price * 1.02,
  };
}

export async function GET() {
  const signals = symbols.map((s) =>
    generateSignal(s, prices[s])
  );

  return Response.json({ signals });
}
