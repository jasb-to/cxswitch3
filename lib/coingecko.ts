const LAST_PRICES: Record<string, number> = {
  BTC: 75000,
  ETH: 2070,
  SOL: 84,
};

export interface PriceData {
  bitcoin: { usd: number; usd_24h_change: number };
  ethereum: { usd: number; usd_24h_change: number };
  solana: { usd: number; usd_24h_change: number };
}

export async function fetchSimplePrice(): Promise<PriceData> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true",
      { cache: "no-store" }
    );
    const data = await res.json();
    
    if (data.bitcoin && data.ethereum && data.solana) {
      LAST_PRICES.BTC = data.bitcoin.usd;
      LAST_PRICES.ETH = data.ethereum.usd;
      LAST_PRICES.SOL = data.solana.usd;
      return data;
    }
    
    return {
      bitcoin: { usd: LAST_PRICES.BTC, usd_24h_change: 0 },
      ethereum: { usd: LAST_PRICES.ETH, usd_24h_change: 0 },
      solana: { usd: LAST_PRICES.SOL, usd_24h_change: 0 },
    };
  } catch (err) {
    console.error("[PRICE] API failed, using fallback:", err);
    return {
      bitcoin: { usd: LAST_PRICES.BTC, usd_24h_change: 0 },
      ethereum: { usd: LAST_PRICES.ETH, usd_24h_change: 0 },
      solana: { usd: LAST_PRICES.SOL, usd_24h_change: 0 },
    };
  }
}
