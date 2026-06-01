export async function getLivePrices() {
  try {
    // OKX public API (NOT blocked in UK)
    const res = await fetch(
      "https://www.okx.com/api/v5/market/tickers?instType=SPOT"
    );

    const json = await res.json();

    const data = json.data || [];

    const map: Record<string, number> = {};

    for (const item of data) {
      map[item.instId] = parseFloat(item.last);
    }

    return {
      BTC: map["BTC-USDT"],
      ETH: map["ETH-USDT"],
      SOL: map["SOL-USDT"],
    };
  } catch (err) {
    console.error("[PRICE FALLBACK]", err);

    return {
      BTC: 71000,
      ETH: 2000,
      SOL: 80,
    };
  }
}
