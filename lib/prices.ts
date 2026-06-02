import { getCurrentPrice } from "./kraken";
import type { Symbol } from "./kraken";

export async function getLivePrices(): Promise<Record<Symbol, number>> {
  const [BTC, ETH, SOL] = await Promise.all([
    getCurrentPrice("BTC"),
    getCurrentPrice("ETH"),
    getCurrentPrice("SOL"),
  ]);

  return {
    BTC: BTC || 0,
    ETH: ETH || 0,
    SOL: SOL || 0,
  };
}
