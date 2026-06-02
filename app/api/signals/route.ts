export async function GET() {
  const prices = {
    BTC: 70000,
    ETH: 2000,
    SOL: 80,
  };

  const signals = Object.entries(prices).map(([symbol, price]) => {
    // pseudo "market behaviour" based on price seed
    const seed = price % 100;

    // compression proxy (tight ranges)
    const compressionScore = (seed % 30) / 30;

    // momentum proxy
    const momentum = ((seed % 10) / 10);

    let state: "EARLY" | "SNIPER" | "WAIT" = "WAIT";

    // 🟣 EARLY = compression building + low momentum
    if (compressionScore < 0.35 && momentum < 0.5) {
      state = "EARLY";
    }

    // 🔥 SNIPER = breakout condition
    if (compressionScore > 0.7 && momentum > 0.6) {
      state = "SNIPER";
    }

    return {
      symbol,
      price,
      state,
      compressionScore: Number(compressionScore.toFixed(2)),
      momentum: Number(momentum.toFixed(2)),
    };
  });

  return Response.json({ signals });
}
