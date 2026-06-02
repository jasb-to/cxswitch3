export async function GET() {
  const prices = {
    BTC: 70000,
    ETH: 2000,
    SOL: 80,
  };

  const signals = Object.entries(prices).map(([symbol, price]) => {
    const r = Math.random();

    return {
      symbol,
      price,
      state: r > 0.75 ? "SNIPER" : r > 0.45 ? "EARLY" : "WAIT",
    };
  });

  return Response.json({ signals });
}
