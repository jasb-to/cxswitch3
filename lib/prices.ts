import { getCurrentPrice } from "@/lib/kraken";

export type Symbol = "BTC" | "ETH" | "SOL";

export async function getLivePrices(): Promise<Record<Symbol, number>> {
  const [btc, eth, sol] = await Promise.all([
    getCurrentPrice("BTC"),
    getCurrentPrice("ETH"),
    getCurrentPrice("SOL"),
  ]);

  return {
    BTC: btc || 70000,
    ETH: eth || 2000,
    SOL: sol || 80,
  };
}
