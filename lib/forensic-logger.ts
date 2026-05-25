/**
 * FORENSIC LOGGING UTILITY
 * 
 * Comprehensive data flow tracing to identify where tp1, tp2, sl, riskReward, and EMA
 * values become zero during transformation.
 * 
 * Format: [FORENSIC_POINT] symbol|tp1|tp2|sl|rr|ema|timestamp|location
 * 
 * Usage:
 *   logForensicPoint("STRATEGY_OUTPUT", card, "BTC");
 *   logForensicPoint("VIEWMODEL_BUILD", viewModel, "BTC");
 *   logForensicPoint("SNAPSHOT_CREATION", snapshotCard, "BTC");
 *   logForensicPoint("DISPATCHER_INPUT", viewModel, "BTC");
 */

export interface ForensicData {
  symbol: string;
  tp1?: number;
  tp2?: number;
  sl?: number;
  rr?: number;
  ema?: number;
  ema4h?: number;
  ema1h?: number;
  direction?: string;
  signalState?: string;
  activationState?: string;
  confidence?: number;
  [key: string]: any;
}

/**
 * Log forensic point with structured format for grep analysis
 */
export function logForensicPoint(
  location: string,
  data: ForensicData | any,
  symbol?: string
): void {
  const sym = symbol || data?.symbol || "UNKNOWN";
  const tp1 = data?.targetPrices?.tp1 || data?.tp1 || data?.takeProfit || 0;
  const tp2 = data?.targetPrices?.tp2 || data?.tp2 || data?.takeProfit || 0;
  const sl = data?.targetPrices?.sl || data?.sl || data?.stopLoss || 0;
  const rr = data?.riskReward || data?.riskRewardRatio || 0;
  const ema = data?.emaShort || data?.ema || 0;
  const ema4h = data?.ema4h || data?.emaLong || 0;
  const ema1h = data?.ema1h || 0;
  const direction = data?.direction || "?";
  const signalState = data?.signalState || "?";
  const activationState = data?.activationState || "?";
  const confidence = data?.confidence || 0;
  
  const timestamp = new Date().toISOString();
  
  // Check for corruption (values that should never be zero)
  const corruptionFlags = [];
  if (tp1 === 0 && location.includes("VIEWMODEL")) corruptionFlags.push("TP1_ZERO");
  if (sl === 0 && location.includes("VIEWMODEL")) corruptionFlags.push("SL_ZERO");
  if (rr === 0 && location.includes("VIEWMODEL")) corruptionFlags.push("RR_ZERO");
  if (ema === 0 && !location.includes("NONE")) corruptionFlags.push("EMA_ZERO");
  
  const flags = corruptionFlags.length > 0 ? `[${corruptionFlags.join(",")}]` : "";
  
  // Structured log for grep
  console.log(
    `[FORENSIC_${location}] ${sym}|tp1=${tp1}|tp2=${tp2}|sl=${sl}|rr=${rr}|ema=${ema}|ema4h=${ema4h}|ema1h=${ema1h}|dir=${direction}|state=${signalState}|act=${activationState}|conf=${confidence}|ts=${timestamp}|${flags}`
  );
  
  // Additional detailed log for debugging
  console.log(`[FORENSIC_DETAIL_${location}] ${sym}:`, {
    tp1,
    tp2,
    sl,
    rr,
    ema,
    ema4h,
    ema1h,
    direction,
    signalState,
    activationState,
    confidence,
    fullData: data,
  });
}

/**
 * Validate that critical values are not zero (only for active trades)
 * CRITICAL: Skip validation for DO_NOT_TRADE - they're allowed to have null/0 values
 */
export function validateForensicData(
  location: string,
  data: ForensicData,
  expectNonZero: string[] = ["tp1", "sl", "rr"]
): boolean {
  const sym = data.symbol || "UNKNOWN";
  
  // 🧊 CRITICAL: Skip validation for frozen/inactive cards
  if (data.signalState === "DO_NOT_TRADE") {
    return true;
  }
  
  let isValid = true;
  
  for (const field of expectNonZero) {
    let value = 0;
    if (field === "tp1") {
      value = data?.targetPrices?.tp1 || data?.tp1 || 0;
    } else if (field === "tp2") {
      value = data?.targetPrices?.tp2 || data?.tp2 || 0;
    } else if (field === "sl") {
      value = data?.targetPrices?.sl || data?.sl || 0;
    } else if (field === "rr") {
      value = data?.riskReward || data?.riskRewardRatio || 0;
    } else if (field === "ema") {
      value = data?.emaShort || data?.ema || 0;
    }
    
    if (value === 0) {
      console.error(
        `[FORENSIC_ERROR] ${location} ${sym}: Expected non-zero ${field}, got ${value}`
      );
      isValid = false;
    }
  }
  
  return isValid;
}

/**
 * Compare data before and after transformation
 */
export function compareForensicData(
  location: string,
  before: ForensicData,
  after: ForensicData
): void {
  const symbol = before.symbol || "UNKNOWN";
  
  const before_tp1 = before?.targetPrices?.tp1 || before?.tp1 || 0;
  const after_tp1 = after?.targetPrices?.tp1 || after?.tp1 || 0;
  
  const before_sl = before?.targetPrices?.sl || before?.sl || 0;
  const after_sl = after?.targetPrices?.sl || after?.sl || 0;
  
  const before_rr = before?.riskReward || before?.riskRewardRatio || 0;
  const after_rr = after?.riskReward || after?.riskRewardRatio || 0;
  
  const before_ema = before?.emaShort || before?.ema || 0;
  const after_ema = after?.emaShort || after?.ema || 0;
  
  if (before_tp1 !== after_tp1 || before_sl !== after_sl || before_rr !== after_rr || before_ema !== after_ema) {
    console.warn(`[FORENSIC_MUTATION_${location}] ${symbol}:`, {
      tp1: `${before_tp1} → ${after_tp1}${before_tp1 !== after_tp1 ? " ⚠️" : ""}`,
      sl: `${before_sl} → ${after_sl}${before_sl !== after_sl ? " ⚠️" : ""}`,
      rr: `${before_rr} → ${after_rr}${before_rr !== after_rr ? " ⚠️" : ""}`,
      ema: `${before_ema} → ${after_ema}${before_ema !== after_ema ? " ⚠️" : ""}`,
    });
  }
}

/**
 * Generate forensic report showing data corruption points
 */
export function generateForensicReport(
  allForensicLogs: Array<{ location: string; symbol: string; tp1: number; sl: number; rr: number; ema: number }>
): void {
  console.log("\n" + "=".repeat(80));
  console.log("[FORENSIC_REPORT] Data corruption analysis");
  console.log("=".repeat(80));
  
  // Group by symbol
  const bySymbol = new Map<string, typeof allForensicLogs>();
  for (const log of allForensicLogs) {
    const sym = log.symbol;
    if (!bySymbol.has(sym)) bySymbol.set(sym, []);
    bySymbol.get(sym)!.push(log);
  }
  
  // Analyze each symbol
  for (const [symbol, logs] of bySymbol.entries()) {
    console.log(`\n[${symbol}]`);
    for (let i = 0; i < logs.length; i++) {
      const log = logs[i];
      const next = logs[i + 1];
      
      console.log(`  ${log.location}: tp1=${log.tp1}, sl=${log.sl}, rr=${log.rr}, ema=${log.ema}`);
      
      if (next) {
        if (log.tp1 !== next.tp1 || log.sl !== next.sl || log.rr !== next.rr) {
          console.log(`    ⚠️ MUTATION: → ${next.location}`);
          if (log.tp1 !== next.tp1) console.log(`       tp1: ${log.tp1} → ${next.tp1}`);
          if (log.sl !== next.sl) console.log(`       sl: ${log.sl} → ${next.sl}`);
          if (log.rr !== next.rr) console.log(`       rr: ${log.rr} → ${next.rr}`);
        }
      }
    }
  }
  
  console.log("\n" + "=".repeat(80) + "\n");
}
