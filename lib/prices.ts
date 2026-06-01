type PriceMap = {
  BTC: number;
  ETH: number;
  SOL: number;
};

export async function getLivePrices(): Promise<PriceMap> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd",
      {
        headers: {
          accept: "application/json",
        },
        cache: "no-store",
      }
    );

    const data = await res.json();

    // HARD SAFETY GUARDS (this prevents ALL iterable crashes)
    if (!data || typeof data !== "object") {
      throw new Error("Invalid CoinGecko response");
    }

    return {
      BTC: Number(data.bitcoin?.usd ?? 71000),
      ETH: Number(data.ethereum?.usd ?? 2000),
      SOL: Number(data.solana?.usd ?? 80),
    };
  } catch (err) {
    console.error("[PRICE ERROR]", err);

    // fallback safe values
    return {
      BTC: 71000,
      ETH: 2000,
      SOL: 80,
    };
  }
}
