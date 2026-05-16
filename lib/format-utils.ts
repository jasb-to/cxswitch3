/**
 * v24.3: Defensive number formatting to prevent toFixed crashes
 * FIX 2: Eliminate toFixed(undefined) errors across the pipeline
 */

/**
 * Safely format a number to fixed decimal places
 * Never throws, always returns a string
 */
export function formatNumber(value: number | null | undefined, decimals: number = 2): string {
  try {
    const num = Number(value ?? 0);
    if (!isFinite(num)) return "0.00";
    return num.toFixed(decimals);
  } catch {
    return "0.00";
  }
}

/**
 * Safely format price (usually 2 decimals)
 */
export function formatPrice(value: number | null | undefined): string {
  return formatNumber(value, 2);
}

/**
 * Safely format percentage (usually 1 decimal)
 */
export function formatPercent(value: number | null | undefined): string {
  return formatNumber(value, 1);
}

/**
 * Safely convert to number with default fallback
 */
export function safeNumber(value: any, fallback: number = 0): number {
  try {
    const num = Number(value);
    return isFinite(num) ? num : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Safely get decimal places count
 */
export function getSafeDecimals(value: number | null | undefined, min: number = 0, max: number = 8): number {
  if (value === null || value === undefined || !isFinite(value)) return min;
  return Math.max(min, Math.min(max, value.toString().split(".")[1]?.length ?? 0));
}
