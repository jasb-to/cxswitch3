/**
 * Derive market bias from existing probability scores
 * Non-invasive visualization of score dominance
 * 
 * Uses relative dominance (normalized to 0–100 range) instead of absolute difference
 * to account for compressed score bands (35–50 typical range)
 * 
 * Does NOT gate any logic - purely visual clarity
 */
export type MarketBias = "BULLISH" | "BEARISH" | "NEUTRAL";
export type BiasStrength = "weak" | "moderate" | "strong";

export function getBias(longScore: number = 0, shortScore: number = 0): MarketBias {
  const total = longScore + shortScore;
  
  // Avoid division by zero
  if (total === 0) return "NEUTRAL";
  
  // Normalized difference as percentage (relative dominance)
  // Reflects which direction has more conviction within the total score
  const diff = longScore - shortScore;
  const normalized = (diff / total) * 100;

  // Threshold: ±6% relative dominance
  if (normalized >= 6) return "BULLISH";
  if (normalized <= -6) return "BEARISH";
  return "NEUTRAL";
}

export function getBiasStrength(longScore: number = 0, shortScore: number = 0): BiasStrength {
  const diff = Math.abs(longScore - shortScore);
  const total = longScore + shortScore;
  
  // Avoid division by zero
  if (total === 0) return "weak";
  
  // Strength as ratio of diff to total score (conviction level)
  const strength = diff / total;

  if (strength > 0.25) return "strong";
  if (strength > 0.12) return "moderate";
  return "weak";
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

