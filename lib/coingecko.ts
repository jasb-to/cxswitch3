/**
 * CoinGecko API - SINGLE CALL ONLY
 * No OHLC. No Redis. No caching.
 * One call returns all 3 symbols with prices + 24h change.
 */

const COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true";

const FALLBACK = {
  bitcoin: { usd: 75000, usd_24h_change: 0 },
  ethereum: { usd: 2070, usd_24h_change: 0 },
  solana: { usd: 84, usd_24h_change: 0 },
};

export interface PriceData {
  price: number;
  change24h: number;
}

export async function fetchPrices(): Promise<Record<string, PriceData>> {
  try {
    const res = await fetch(COINGECKO_URL, { 
      cache: "no-store",
      headers: { "Accept": "application/json" }
    });

    if (!res.ok) {
      console.warn("[CG] API failed:", res.status, "using fallback");
      return {
        BTC: { price: FALLBACK.bitcoin.usd, change24h: FALLBACK.bitcoin.usd_24h_change },
        ETH: { price: FALLBACK.ethereum.usd, change24h: FALLBACK.ethereum.usd_24h_change },
        SOL: { price: FALLBACK.solana.usd, change24h: FALLBACK.solana.usd_24h_change },
      };
    }

    const data = await res.json();

    return {
      BTC: { 
        price: data.bitcoin?.usd || FALLBACK.bitcoin.usd, 
        change24h: data.bitcoin?.usd_24h_change || 0 
      },
      ETH: { 
        price: data.ethereum?.usd || FALLBACK.ethereum.usd, 
        change24h: data.ethereum?.usd_24h_change || 0 
      },
      SOL: { 
        price: data.solana?.usd || FALLBACK.solana.usd, 
        change24h: data.solana?.usd_24h_change || 0 
      },
    };
  } catch (err) {
    console.warn("[CG] Fetch crashed:", err.message, "using fallback");
    return {
      BTC: { price: FALLBACK.bitcoin.usd, change24h: FALLBACK.bitcoin.usd_24h_change },
      ETH: { price: FALLBACK.ethereum.usd, change24h: FALLBACK.ethereum.usd_24h_change },
      SOL: { price: FALLBACK.solana.usd, change24h: FALLBACK.solana.usd_24h_change },
    };
  }
}
