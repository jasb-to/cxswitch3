/**
 * FILE: lib/coingecko.ts
 * PURPOSE: Fetch crypto prices from CoinGecko with 2-minute cache
 * WHY: Prevents 429 rate limits when UI + cron both call API
 */

const COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true";

// Cache storage
let cachedPrices: Record<string, { price: number; change24h: number }> | null = null;
let cacheTime = 0;
const CACHE_TTL = 120000; // 2 minutes in milliseconds

export interface PriceData {
  price: number;
  change24h: number;
}

export async function fetchPrices(): Promise<Record<string, PriceData>> {
  const now = Date.now();
  
  // Return cached data if still fresh
  if (cachedPrices && (now - cacheTime) < CACHE_TTL) {
    return cachedPrices;
  }
  
  // Fetch fresh data from CoinGecko
  try {
    const res = await fetch(COINGECKO_URL, { 
      cache: "no-store",
      headers: { "Accept": "application/json" }
    });
    
    if (!res.ok) {
      console.warn("[CG] API failed:", res.status, "using cache or fallback");
      // Return stale cache if available, else hardcoded fallback
      if (cachedPrices) return cachedPrices;
      return {
        BTC: { price: 75000, change24h: 0 },
        ETH: { price: 2070, change24h: 0 },
        SOL: { price: 84, change24h: 0 },
      };
    }
    
    const data = await res.json();
    
    cachedPrices = {
      BTC: { 
        price: data.bitcoin?.usd || 75000, 
        change24h: data.bitcoin?.usd_24h_change || 0 
      },
      ETH: { 
        price: data.ethereum?.usd || 2070, 
        change24h: data.ethereum?.usd_24h_change || 0 
      },
      SOL: { 
        price: data.solana?.usd || 84, 
        change24h: data.solana?.usd_24h_change || 0 
      },
    };
    
    cacheTime = now;
    return cachedPrices;
    
  } catch (err) {
    console.warn("[CG] Fetch crashed:", err, "using cache or fallback");
    if (cachedPrices) return cachedPrices;
    return {
      BTC: { price: 75000, change24h: 0 },
      ETH: { price: 2070, change24h: 0 },
      SOL: { price: 84, change24h: 0 },
    };
  }
}
