export async function getLivePrices() {
  try {
    // OKX public endpoint (stable + UK-safe)
    const res = await fetch(
      "https://www.okx.com/api/v5/market/tickers?instType=SPOT"
    );

    const json = await res.json();

    const list = Array.isArray(json?.data) ? json.data : [];

    const map: Record<string, number> = {};

    for (const item of list) {
      if (!item?.instId || !item?.last) continue;

      map[item.instId] = Number(item.last);
    }

    return {
      BTC: map["BTC-USDT"] || 71000,
      ETH: map["ETH-USDT"] || 2000,
      SOL: map["SOL-USDT"] || 80,
    };
  } catch (err) {
    console.error("[PRICE ERROR]", err);

    return {
      BTC: 71000,
      ETH: 2000,
      SOL: 80,
    };
  }
}
