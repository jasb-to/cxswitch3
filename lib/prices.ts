import { getCurrentPrice, type Symbol } from "@/lib/kraken";

export async function getLivePrices(): Promise<Record<Symbol, number>> {
  const [btc, eth, sol] = await Promise.all([
    getCurrentPrice("BTC"),
    getCurrentPrice("ETH"),
    getCurrentPrice("SOL"),
  ]);

  return {
    BTC: btc > 0 ? btc : 70000,
    ETH: eth > 0 ? eth : 2000,
    SOL: sol > 0 ? sol : 80,
  };
}
