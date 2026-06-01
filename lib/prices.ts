export async function getLivePrices() {
  try {
    const res = await fetch(
      "https://api.binance.com/api/v3/ticker/price"
    );

    const data = await res.json();

    const map: Record<string, number> = {};

    for (const item of data) {
      map[item.symbol] = parseFloat(item.price);
    }

    return {
      BTC: map["BTCUSDT"],
      ETH: map["ETHUSDT"],
      SOL: map["SOLUSDT"],
    };
  } catch (err) {
    console.error("[PRICE ERROR]", err);

    // fallback only
    return {
      BTC: 71000,
      ETH: 2000,
      SOL: 80,
    };
  }
}
