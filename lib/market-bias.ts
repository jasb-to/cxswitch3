/**
 * Derive market bias from existing probability scores
 * Non-invasive visualization of score dominance
 * 
 * Does NOT gate any logic - purely visual clarity
 */
export type MarketBias = "BULLISH" | "BEARISH" | "NEUTRAL";

export function getBias(longScore: number = 0, shortScore: number = 0): MarketBias {
  const diff = longScore - shortScore;

  if (diff >= 10) return "BULLISH";
  if (diff <= -10) return "BEARISH";
  return "NEUTRAL";
}

export function getBiasColor(bias: MarketBias): string {
  switch (bias) {
    case "BULLISH":
      return "text-[#22c55e]";
    case "BEARISH":
      return "text-[#ef4444]";
    case "NEUTRAL":
      return "text-[#888]";
  }
}

export function getBiasBorder(bias: MarketBias): string {
  switch (bias) {
    case "BULLISH":
      return "border-[#22c55e]";
    case "BEARISH":
      return "border-[#ef4444]";
    case "NEUTRAL":
      return "border-[#666]";
  }
}
