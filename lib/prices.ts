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

    const btc = Number(data?.bitcoin?.usd);
    const eth = Number(data?.ethereum?.usd);
    const sol = Number(data?.solana?.usd);

    return {
      BTC: Number.isFinite(btc) ? btc : 70000,
      ETH: Number.isFinite(eth) ? eth : 2000,
      SOL: Number.isFinite(sol) ? sol : 80,
    };
  } catch (err) {
    console.error("[PRICE ERROR]", err);

    return {
      BTC: 70000,
      ETH: 2000,
      SOL: 80,
    };
  }
}
