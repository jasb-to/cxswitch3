export type PriceMap = {
  BTC: number;
  ETH: number;
  SOL: number;
};

export async function getLivePrices(): Promise<PriceMap> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd",
      { cache: "no-store" }
    );

    const data = await res.json();

    return {
      BTC: Number(data?.bitcoin?.usd ?? 70000),
      ETH: Number(data?.ethereum?.usd ?? 2000),
      SOL: Number(data?.solana?.usd ?? 80),
    };
  } catch (e) {
    console.error("[PRICE ERROR]", e);

    return {
      BTC: 70000,
      ETH: 2000,
      SOL: 80,
    };
  }
}
