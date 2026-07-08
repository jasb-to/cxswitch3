// lib/strategy.ts — v29.3 "Early Entry Orchestrator"
// ============================================================
// CORE PRINCIPLES:
// 1. 1H StochRSI K/D crossover on CURRENT confirmed candle = THE trigger
// 2. Regime (1D EMA) filters direction. 4H modulates confidence, NEVER blocks.
// 3. Everything else (ADX, volume, structure, exhaustion) modulates CONFIDENCE.
// 4. UI and cron use SAME persisted regime from KV. No brain split.
// 5. Every rejected signal is logged with full breakdown.
//
// The question: "Is this the beginning of a move?"
// NOT: "Has the move already proven itself?"
// ============================================================

import { Candle, Signal, MarketData, SignalResult, PairConfig, TradeManagerUpdate, ValidityCheck, HoldResult, ExitRecord, RejectionLog } from "@/lib/types";
import { getRegime, setRegimePersistence, persistRegime, getRegimeSync } from "@/lib/regime/persistence";
import { evaluateRegime, shouldInvalidateRegime } from "@/lib/regime/engine";
import { stochRsi } from "@/lib/indicators/stochrsi";
import { adx } from "@/lib/indicators/adx";
import { buildConfidence, meetsThreshold } from "@/lib/scoring/confidence";

export * from "@/lib/types";
export { setRegimePersistence, evaluateRegime, shouldInvalidateRegime } from "@/lib/regime/engine";
export { setRegimePersistence as setRegimePersistenceHook, getRegimeSync } from "@/lib/regime/persistence";

export const CURRENT_SIGNAL_VERSION = 29;

// ─── Pair Config (unchanged from v28) ───

const PAIR_CONFIGS: Record<string, PairConfig> = {
  default: { minADX: 20, momentumThreshold: 55, volumeMultiplier: 1.3, stopLossPct: 0.025, takeProfitPct: 0.035, maxEntryDriftPct: 0.01 },
  BTC: { minADX: 20, momentumThreshold: 55, volumeMultiplier: 1.3, stopLossPct: 0.02, takeProfitPct: 0.03, maxEntryDriftPct: 0.01 },
  ETH: { minADX: 20, momentumThreshold: 55, volumeMultiplier: 1.3, stopLossPct: 0.025, takeProfitPct: 0.035, maxEntryDriftPct: 0.01 },
  SOL: { minADX: 18, momentumThreshold: 50, volumeMultiplier: 1.4, stopLossPct: 0.03, takeProfitPct: 0.04, maxEntryDriftPct: 0.012 },
  HYPE: {
    minADX: 20, momentumThreshold: 60, volumeMultiplier: 1.5, stopLossPct: 0.06, takeProfitPct: 0.05, maxEntryDriftPct: 0.02,
    isHYPE: true, deepCrossThresholdLong: 25, deepCrossThresholdShort: 75, maxRecentVolatility: 0.08,
    bePct: 0.02, lockPct: 0.025, runnerPct: 0.04,
  },
};

export function getPairConfig(pair: string): PairConfig {
  return PAIR_CONFIGS[pair] || PAIR_CONFIGS.default;
}

// ─── Candle Aggregation ───

function aggregateTo1D(candles4h: Candle[]): Candle[] {
  if (!candles4h || candles4h.length < 6) return [];
  const sorted = [...candles4h].sort((a, b) => a.timestamp - b.timestamp);
  const groups: Map<string, Candle[]> = new Map();
  for (const c of sorted) {
    const d = new Date(c.timestamp);
    const key = d.toISOString().split("T")[0];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  const daily: Candle[] = [];
  for (const [, bars] of groups) {
    if (!bars.length) continue;
    daily.push({
      timestamp: bars[0].timestamp,
      open: bars[0].open,
      high: Math.max(...bars.map(b => b.high)),
      low: Math.min(...bars.map(b => b.low)),
      close: bars[bars.length - 1].close,
      volume: bars.reduce((s, b) => s + b.volume, 0)
    });
  }
  return daily.sort((a, b) => a.timestamp - b.timestamp);
}

function avg(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

// ─── Exhaustion Check (soft modifier, not a gate) ───

function checkExhaustion(stoch4h: { k: number; d: number }, tradeDirection: "LONG" | "SHORT"): { isExhausted: boolean; reason: string; confidencePenalty: number } {
  if (tradeDirection === "LONG") {
    if (stoch4h.k > 90) return { isExhausted: true, reason: `4H extreme overbought K${stoch4h.k}`, confidencePenalty: -20 };
    if (stoch4h.k > 80 && stoch4h.k < stoch4h.d) return { isExhausted: true, reason: `4H overbought exhaustion K${stoch4h.k} < D${stoch4h.d}`, confidencePenalty: -15 };
  } else {
    if (stoch4h.k < 10) return { isExhausted: true, reason: `4H extreme oversold K${stoch4h.k}`, confidencePenalty: -20 };
    if (stoch4h.k < 20 && stoch4h.k > stoch4h.d) return { isExhausted: true, reason: `4H oversold exhaustion K${stoch4h.k} > D${stoch4h.d}`, confidencePenalty: -15 };
  }
  return { isExhausted: false, reason: "", confidencePenalty: 0 };
}

// ─── REJECTION LOGGING ───

const rejectionLogs: RejectionLog[] = [];
const MAX_REJECTION_LOGS = 1000;

function logRejection(log: RejectionLog): void {
  rejectionLogs.push(log);
  if (rejectionLogs.length > MAX_REJECTION_LOGS) {
    rejectionLogs.shift();
  }
  // Also console for immediate visibility
  console.log(`[REJECTED] ${log.pair} | cross=${log.crossDetected ? log.crossDirection : "none"} | regime=${log.regimeDirection} | conf=${log.confidenceScore} | reason=${log.rejectionReason}`);
}

export function getRejectionLogs(pair?: string, since?: number): RejectionLog[] {
  let logs = rejectionLogs;
  if (pair) logs = logs.filter(l => l.pair === pair);
  if (since) logs = logs.filter(l => l.timestamp >= since);
  return logs;
}

export function clearRejectionLogs(): void {
  rejectionLogs.length = 0;
}

// ─── EARLY ENTRY SCORING ───
// 1H StochRSI K/D crossover on CONFIRMED candle = THE trigger.
// Previous candle: K <= D (LONG) or K >= D (SHORT)
// Current candle: K > D (LONG) or K < D (SHORT)

interface EarlyEntryCandidate {
  direction: "LONG" | "SHORT";
  strength: number;
  finalConfidence: number;
  reasons: string[];
  confidenceComponents: Record<string, number>;
  stochK: number;
  stochD: number;
  stochPrevK: number;
  stochPrevD: number;
  entryPrice: number;
  confidencePenalty: number;
  exhaustionWarning: string;
}

function scoreEarlyEntry(
  candles1h: Candle[],
  candles4h: Candle[],
  config: PairConfig,
  pair: string,
  regimeDirection: "LONG" | "SHORT"
): EarlyEntryCandidate | null {
  const reasons: string[] = [];
  const closes = candles1h.map(c => c.close);
  const volumes = candles1h.map(c => c.volume);
  if (closes.length < 50) return null;

  // ─── CORE TRIGGER: CONFIRMED 1H StochRSI K/D crossover ───
  // We need EXACTLY the current candle's cross, not "sometime in last 5"
  const stoch = stochRsi(closes);
  const stochPrev = stochRsi(closes.slice(0, -1));

  // LONG: previous K <= D, current K > D
  const crossUp = stochPrev.k <= stochPrev.d && stoch.k > stoch.d;
  // SHORT: previous K >= D, current K < D
  const crossDown = stochPrev.k >= stochPrev.d && stoch.k < stoch.d;

  let direction: "LONG" | "SHORT" | null = null;
  if (crossUp) direction = "LONG";
  else if (crossDown) direction = "SHORT";

  // No confirmed crossover = no entry. Period.
  if (!direction) return null;

  // Regime mismatch = no entry. Period.
  if (direction !== regimeDirection) return null;

  // ─── CONFIDENCE SCORING ───
  let base = 30; reasons.push("regime_alignment:+30");
  let setup = 0, momentum = 0, structure = 0, volume = 0;

  // Setup quality: how deep is the cross? (earlier = better)
  if (config.isHYPE) {
    if (direction === "LONG") {
      if (stoch.k < (config.deepCrossThresholdLong || 25)) { setup += 20; reasons.push("deep_cross:+20"); }
      else if (stoch.k < 40) { setup += 10; reasons.push("moderate_cross:+10"); }
      else { setup -= 20; reasons.push("shallow_cross:-20"); }
    } else {
      if (stoch.k > (config.deepCrossThresholdShort || 75)) { setup += 20; reasons.push("deep_cross:+20"); }
      else if (stoch.k > 60) { setup += 10; reasons.push("moderate_cross:+10"); }
      else { setup -= 20; reasons.push("shallow_cross:-20"); }
    }
  } else {
    if (direction === "LONG") {
      if (stoch.k < 35) { setup += 15; reasons.push("deep_cross:+15"); }
      else if (stoch.k < 50) { setup += 5; reasons.push("moderate_cross:+5"); }
      else if (stoch.k > 70) { setup -= 15; reasons.push("extended_cross:-15"); }
    } else {
      if (stoch.k > 65) { setup += 15; reasons.push("deep_cross:+15"); }
      else if (stoch.k > 50) { setup += 5; reasons.push("moderate_cross:+5"); }
      else if (stoch.k < 30) { setup -= 15; reasons.push("extended_cross:-15"); }
    }
  }

  // Momentum: velocity of the move
  const roc = ((closes[closes.length - 1] - closes[closes.length - 4]) / closes[closes.length - 4]) * 100;
  if (Math.abs(roc) > 2.0) { momentum += 10; reasons.push("strong_velocity:+10"); }
  else if (Math.abs(roc) > 1.0) { momentum += 5; reasons.push("velocity:+5"); }
  else if (Math.abs(roc) < 0.3) { momentum -= 5; reasons.push("low_velocity:-5"); }

  // 4H context = CONFIDENCE factor, NOT a gate
  // 4H aligned with regime direction = bonus, opposing = no penalty
  const stoch4h = stochRsi(candles4h.map(c => c.close));
  if (direction === "LONG" && stoch4h.k < 50) { 
    momentum += 10; reasons.push("4h_context_bullish:+10"); 
  } else if (direction === "LONG") {
    reasons.push("4h_context_mixed:0");
  }
  if (direction === "SHORT" && stoch4h.k > 50) { 
    momentum += 10; reasons.push("4h_context_bearish:+10"); 
  } else if (direction === "SHORT") {
    reasons.push("4h_context_mixed:0");
  }

  // Structure: ADX confirms trend strength
  const adx1h = adx(candles1h);
  if (adx1h > config.minADX + 5) { structure += 15; reasons.push(`adx_strong_${adx1h.toFixed(1)}:+15`); }
  else if (adx1h > config.minADX) { structure += 10; reasons.push(`adx_ok_${adx1h.toFixed(1)}:+10`); }
  else if (adx1h > 10) { structure += 5; reasons.push(`adx_weak_${adx1h.toFixed(1)}:+5`); }
  else { structure -= 10; reasons.push(`adx_too_weak_${adx1h.toFixed(1)}:-10`); }

  // Volume: confirms or denies
  const avgVol = avg(volumes.slice(-10));
  const lastVol = volumes[volumes.length - 1];
  const lastCandle = candles1h[candles1h.length - 1];
  const volDirection = lastCandle.close > lastCandle.open ? "LONG" : "SHORT";
  if (lastVol > avgVol * config.volumeMultiplier * 1.5) { 
    volume += 15; reasons.push("strong_volume:+15"); 
  } else if (lastVol > avgVol * config.volumeMultiplier) { 
    volume += 10; reasons.push("volume_confirms:+10"); 
  } else if (lastVol > avgVol) { 
    volume += 5; reasons.push("volume_above_avg:+5"); 
  } else { 
    volume -= 5; reasons.push("volume_weak:-5"); 
  }

  if (volDirection !== direction && lastVol > avgVol) {
    volume -= 10; reasons.push("volume_opposes_direction:-10");
  }

  const components = buildConfidence(base, setup, momentum, structure, volume, 0);

  return {
    direction, strength: components.total, finalConfidence: components.total,
    reasons, confidenceComponents: components as any, 
    stochK: stoch.k, stochD: stoch.d,
    stochPrevK: stochPrev.k, stochPrevD: stochPrev.d,
    entryPrice: candles1h[candles1h.length - 1].close, 
    confidencePenalty: 0, exhaustionWarning: "",
  };
}

// ─── Exit Store (unchanged from v28) ───

const exitStoreById: Map<string, ExitRecord> = new Map();
const exitStoreByPair: Map<string, ExitRecord> = new Map();

let persistExitFn: ((record: ExitRecord) => Promise<void>) | null = null;
let loadExitsFn: (() => Promise<ExitRecord[]>) | null = null;

export function setExitPersistence(persist: (r: ExitRecord) => Promise<void>, load: () => Promise<ExitRecord[]>): void {
  persistExitFn = persist;
  loadExitsFn = load;
}

async function recordExit(signalId: string, pair: string, direction: "LONG" | "SHORT", exitPrice: number, exitReason: string, now: number): Promise<void> {
  const r: ExitRecord = { signalId, pair, direction, exitTimestamp: now, exitReason, exitPrice };
  exitStoreById.set(signalId, r);
  exitStoreByPair.set(pair, r);
  if (persistExitFn) { try { await persistExitFn(r); } catch (e) { console.error("[EXIT PERSIST] Failed:", e); } }
}

export async function loadExits(): Promise<void> {
  if (!loadExitsFn) return;
  try { const exits = await loadExitsFn(); for (const r of exits) { exitStoreById.set(r.signalId, r); exitStoreByPair.set(r.pair, r); } }
  catch (e) { console.error("[EXIT LOAD] Failed:", e); }
}

export function hasExited(signalId: string): boolean { return exitStoreById.has(signalId); }

const EXIT_COOLDOWN_MS = 8 * 60 * 60 * 1000;

function isInCooldown(pair: string, now: number, direction?: "LONG" | "SHORT"): { inCooldown: boolean; remainingMs: number; lastExit?: ExitRecord } {
  const lastExit = exitStoreByPair.get(pair);
  if (!lastExit) return { inCooldown: false, remainingMs: 0 };
  if (direction && lastExit.direction !== direction) return { inCooldown: false, remainingMs: 0, lastExit };
  const elapsed = now - lastExit.exitTimestamp;
  return elapsed < EXIT_COOLDOWN_MS ? { inCooldown: true, remainingMs: EXIT_COOLDOWN_MS - elapsed, lastExit } : { inCooldown: false, remainingMs: 0, lastExit };
}

// ─── MAIN SIGNAL GENERATION (v29.3) ───
// ⚠️  THIS IS NOW ASYNC — ALL CALLERS MUST AWAIT

export async function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  activeTrades?: Record<string, any>,
  currentPrice?: number
): Promise<SignalResult> {
  const debug: string[] = [];
  const config = getPairConfig(pair);
  const now = Date.now();

  if (activeTrades && activeTrades[pair]) {
    debug.push("Active trade exists, skipping duplicate entry");
    const stoch4hQuick = stochRsi(candles4h.map(c => c.close));
    const stoch1hQuick = stochRsi(candles1h.map(c => c.close));
    const price = currentPrice ?? candles1h[candles1h.length - 1].close;
    const market: MarketData = {
      pair, price: Math.round(price * 100) / 100, timestamp: now,
      phase: "WATCHING", trend: "ACTIVE_TRADE",
      htfBias: "MIXED",
      adx: Math.round(adx(candles4h) * 10) / 10, rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
      stochK: stoch4hQuick.k, stochD: stoch4hQuick.d, stoch1hK: stoch1hQuick.k, stoch1hD: stoch1hQuick.d,
    };
    return { market, debug };
  }

  for (let i = 1; i < candles4h.length; i++) {
    if (candles4h[i].timestamp < candles4h[i - 1].timestamp) { debug.push("Candles not sorted"); return { debug }; }
  }

  const candles1d = aggregateTo1D(candles4h);
  debug.push(`1D candles: ${candles1d.length} days from ${candles4h.length} 4H bars`);

  if (candles1d.length < 25 || candles4h.length < 30 || candles1h.length < 50) {
    debug.push(`Insufficient candle data: 1D=${candles1d.length}, 4H=${candles4h.length}, 1H=${candles1h.length}`);
    return { debug };
  }

  // Load or evaluate regime (async — from KV cache)
  const regime = await getRegime(pair, candles1d, candles4h);
  debug.push(`REGIME: ${regime.direction || "NEUTRAL"} ${regime.strength} conf=${regime.confidence}`);
  debug.push(`Regime reasons: ${regime.reason.join(", ")}`);

  if (!regime.direction || regime.direction === "NEUTRAL") {
    debug.push("Regime is NEUTRAL — no directional bias");
    const price = currentPrice ?? candles1h[candles1h.length - 1].close;
    const stoch4h = stochRsi(candles4h.map(c => c.close));
    const stoch1h = stochRsi(candles1h.map(c => c.close));
    const market: MarketData = {
      pair, price: Math.round(price * 100) / 100, timestamp: now,
      phase: "WATCHING", trend: "NEUTRAL",
      htfBias: "MIXED", regime,
      adx: Math.round(adx(candles4h) * 10) / 10, rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
      stochK: stoch4h.k, stochD: stoch4h.d, stoch1hK: stoch1h.k, stoch1hD: stoch1h.d,
    };
    return { market, debug };
  }

  const price = currentPrice ?? candles1h[candles1h.length - 1].close;
  const stoch4h = stochRsi(candles4h.map(c => c.close));
  const stoch1h = stochRsi(candles1h.map(c => c.close));
  const adx4h = adx(candles4h);

  const cooldown = isInCooldown(pair, now, regime.direction);
  if (cooldown.inCooldown) {
    debug.push(`EXIT COOLDOWN: ${(cooldown.remainingMs / 3600000).toFixed(1)}h remaining`);
    const market: MarketData = {
      pair, price: Math.round(price * 100) / 100, timestamp: now,
      phase: "WATCHING", trend: `${regime.direction} ${regime.strength}`,
      htfBias: regime.direction === "LONG" ? "BULLISH" : "BEARISH", regime,
      adx: Math.round(adx4h * 10) / 10, rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
      stochK: stoch4h.k, stochD: stoch4h.d, stoch1hK: stoch1h.k, stoch1hD: stoch1h.d,
    };
    return { market, debug };
  }

  // ─── EARLY ENTRY: Confirmed 1H StochRSI K/D crossover is the trigger ───
  const candidate = scoreEarlyEntry(candles1h, candles4h, config, pair, regime.direction);

  if (!candidate) {
    // Log why we rejected
    const stochCurrent = stochRsi(candles1h.map(c => c.close));
    const stochPrevious = stochRsi(candles1h.slice(0, -1).map(c => c.close));
    const crossUp = stochPrevious.k <= stochPrevious.d && stochCurrent.k > stochCurrent.d;
    const crossDown = stochPrevious.k >= stochPrevious.d && stochCurrent.k < stochCurrent.d;
    const crossDetected = crossUp || crossDown;
    const crossDirection = crossUp ? "LONG" : crossDown ? "SHORT" : null;

    let rejectionReason = "no_confirmed_cross";
    if (crossDetected && crossDirection !== regime.direction) {
      rejectionReason = `cross_${crossDirection}_vs_regime_${regime.direction}`;
    }

    logRejection({
      pair,
      timestamp: now,
      crossDetected,
      crossDirection,
      regimeDirection: regime.direction || "NEUTRAL",
      regimeStrength: regime.strength,
      confidenceScore: 0,
      confidenceBreakdown: {},
      rejectionReason,
      stochK: stochCurrent.k,
      stochD: stochCurrent.d,
      stochPrevK: stochPrevious.k,
      stochPrevD: stochPrevious.d,
    });

    debug.push(`REJECTED: ${rejectionReason} | K=${stochCurrent.k} D=${stochCurrent.d} prevK=${stochPrevious.k} prevD=${stochPrevious.d}`);

    const market: MarketData = {
      pair, price: Math.round(price * 100) / 100, timestamp: now,
      phase: "WATCHING", trend: `${regime.direction} ${regime.strength}`,
      htfBias: regime.direction === "LONG" ? "BULLISH" : "BEARISH", regime,
      adx: Math.round(adx4h * 10) / 10, rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
      stochK: stoch4h.k, stochD: stoch4h.d, stoch1hK: stoch1h.k, stoch1hD: stoch1h.d,
    };
    return { market, debug };
  }

  debug.push(`CROSSOVER CONFIRMED: ${candidate.direction} prevK${candidate.stochPrevK}<=prevD${candidate.stochPrevD} → K${candidate.stochK}>D${candidate.stochD} raw=${candidate.strength}`);
  debug.push(`Components: ${JSON.stringify(candidate.confidenceComponents)}`);

  // Apply exhaustion modifier (soft, not a gate)
  const exhaustion = checkExhaustion(stoch4h, candidate.direction);
  if (exhaustion.isExhausted) {
    candidate.confidencePenalty = exhaustion.confidencePenalty;
    candidate.finalConfidence = Math.min(100, Math.max(0, candidate.strength + exhaustion.confidencePenalty));
    candidate.exhaustionWarning = exhaustion.reason;
    candidate.confidenceComponents.riskPenalty = exhaustion.confidencePenalty;
    candidate.confidenceComponents.total = candidate.finalConfidence;
    debug.push(`EXHAUSTION: ${exhaustion.reason} → ${candidate.strength} → ${candidate.finalConfidence}`);
  }

  // Final confidence check
  if (candidate.finalConfidence < config.momentumThreshold) {
    debug.push(`FINAL CONFIDENCE ${candidate.finalConfidence} below threshold ${config.momentumThreshold} — blocked`);

    logRejection({
      pair,
      timestamp: now,
      crossDetected: true,
      crossDirection: candidate.direction,
      regimeDirection: regime.direction || "NEUTRAL",
      regimeStrength: regime.strength,
      confidenceScore: candidate.finalConfidence,
      confidenceBreakdown: candidate.confidenceComponents,
      rejectionReason: `confidence_too_low_${candidate.finalConfidence}_vs_${config.momentumThreshold}`,
      stochK: candidate.stochK,
      stochD: candidate.stochD,
      stochPrevK: candidate.stochPrevK,
      stochPrevD: candidate.stochPrevD,
    });

    const market: MarketData = {
      pair, price: Math.round(price * 100) / 100, timestamp: now,
      phase: "WATCHING", trend: `${regime.direction} ${regime.strength}`,
      htfBias: regime.direction === "LONG" ? "BULLISH" : "BEARISH", regime,
      adx: Math.round(adx4h * 10) / 10, rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
      stochK: stoch4h.k, stochD: stoch4h.d, stoch1hK: stoch1h.k, stoch1hD: stoch1h.d,
    };
    return { market, debug };
  }

  debug.push(`SELECTED: ${candidate.direction} EARLY_ENTRY conf=${candidate.finalConfidence} (raw=${candidate.strength} penalty=${candidate.confidencePenalty})`);

  const entry = price;
  const sl = candidate.direction === "LONG" ? entry * (1 - config.stopLossPct) : entry * (1 + config.stopLossPct);
  const tp = candidate.direction === "LONG" ? entry * (1 + config.takeProfitPct) : entry * (1 - config.takeProfitPct);
  const rr = Math.abs(tp - entry) / Math.abs(entry - sl);
  debug.push(`R:R ${rr.toFixed(2)} (${(config.stopLossPct * 100).toFixed(0)}% SL / ${(config.takeProfitPct * 100).toFixed(0)}% TP)`);

  const exhaustionNote = candidate.exhaustionWarning ? ` | WARNING: ${candidate.exhaustionWarning}` : "";

  const signal: Signal = {
    id: `${pair}_${now}`,
    pair,
    direction: candidate.direction,
    type: "ENTRY",
    scale: "ENTRY_1",
    entry: Math.round(entry * 100) / 100,
    stop: Math.round(sl * 100) / 100,
    target: Math.round(tp * 100) / 100,
    confidence: candidate.finalConfidence,
    rr: Math.round(rr * 100) / 100,
    adx: Math.round(adx4h * 10) / 10,
    rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
    stochK: stoch4h.k,
    stochD: stoch4h.d,
    stoch1hK: candidate.stochK,
    stoch1hD: candidate.stochD,
    expectedMove: Math.round((Math.abs(tp - entry) / entry) * 100 * 10) / 10,
    reason: `${candidate.direction} EARLY ENTRY | Regime ${regime.direction} ${regime.strength} (since ${new Date(regime.detectedAt).toISOString().split('T')[0]}) | 1H StochRSI K${candidate.stochK}→D${candidate.stochD} cross (prev K${candidate.stochPrevK}/D${candidate.stochPrevD}) | ${candidate.reasons.join(", ")} | RR ${rr.toFixed(2)} | SL ${(config.stopLossPct * 100).toFixed(1)}% TP ${(config.takeProfitPct * 100).toFixed(1)}%${exhaustionNote}`,
    timestamp: now,
    version: CURRENT_SIGNAL_VERSION,
    tradeState: "OPEN",
    lockedStop: null,
    highestPrice: entry,
    lowestPrice: entry,
    profitLockActive: false,
    regimeDirection: regime.direction,
    regimeSince: regime.detectedAt,
    entryMode: "PULLBACK",
    confidenceComponents: candidate.confidenceComponents,
    exhaustionWarning: candidate.exhaustionWarning || undefined,
  };

  const market: MarketData = {
    pair, price: Math.round(price * 100) / 100, timestamp: now,
    phase: "EARLY_ENTRY",
    trend: `${regime.direction} ${regime.strength}`,
    htfBias: candidate.direction === "LONG" ? "BULLISH" : "BEARISH",
    regime,
    adx: signal.adx, rsi: signal.rsi,
    stochK: stoch4h.k, stochD: stoch4h.d,
    stoch1hK: stoch1h.k, stoch1hD: stoch1h.d,
  };

  debug.push(`SIGNAL: ${signal.direction} ${signal.type} entry=${signal.entry} TP=${signal.target} SL=${signal.stop} RR=${signal.rr} conf=${signal.confidence}`);
  return { signal, market, debug };
}

// ─── Market Snapshot ───

export async function getMarketSnapshot(pair: string, candles1h: Candle[], candles4h: Candle[], candles15m: Candle[]): Promise<MarketData> {
  const candles1d = aggregateTo1D(candles4h);
  const stoch4h = stochRsi(candles4h.map(c => c.close));
  const stoch1h = stochRsi(candles1h.map(c => c.close));
  const price = candles4h[candles4h.length - 1].close;
  const adx4h = adx(candles4h);

  let regime: any;
  try { regime = await getRegime(pair, candles1d, candles4h); } catch { /* ignore */ }

  return {
    pair, price: Math.round(price * 100) / 100, timestamp: Date.now(),
    phase: "WATCHING",
    trend: regime ? `${regime.direction} ${regime.strength}` : "UNKNOWN",
    htfBias: regime?.direction === "LONG" ? "BULLISH" : regime?.direction === "SHORT" ? "BEARISH" : "MIXED",
    regime,
    adx: Math.round(adx4h * 10) / 10, rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
    stochK: stoch4h.k, stochD: stoch4h.d, stoch1hK: stoch1h.k, stoch1hD: stoch1h.d,
  };
}

// ─── Trade Manager (UNCHANGED from v28) ───

export function updateTradeManager(signal: Signal, currentPrice: number): TradeManagerUpdate {
  const highest = Math.max(signal.highestPrice || signal.entry, currentPrice);
  const lowest = Math.min(signal.lowestPrice || signal.entry, currentPrice);
  let state = signal.tradeState || "OPEN";
  let locked = signal.lockedStop || signal.stop;
  let profitLock = signal.profitLockActive || false;
  let exit = false;
  let exitReason = "";

  const pnlPct = signal.direction === "LONG" ? (currentPrice - signal.entry) / signal.entry : (signal.entry - currentPrice) / signal.entry;

  const config = getPairConfig(signal.pair);
  const bePct = config.bePct || 0.015;
  const lockPct = config.lockPct || 0.03;
  const runnerPct = config.runnerPct || 0.05;
  const trailRatio = config.isHYPE ? 0.4 : 0.5;

  if (pnlPct >= bePct && state === "OPEN") { state = "BREAK_EVEN"; locked = signal.entry; }
  if (pnlPct >= lockPct && state === "BREAK_EVEN") {
    state = "LOCKED";
    profitLock = true;
    locked = signal.direction === "LONG" ? signal.entry * (1 + bePct * 0.5) : signal.entry * (1 - bePct * 0.5);
  }
  if (pnlPct >= runnerPct && state === "LOCKED") {
    state = "RUNNER";
    const trailDistance = signal.direction === "LONG" ? (highest - signal.entry) * trailRatio : (signal.entry - lowest) * trailRatio;
    locked = signal.direction === "LONG" ? Math.max(locked, highest - trailDistance) : Math.min(locked, lowest + trailDistance);
  }

  if (signal.direction === "LONG" && currentPrice <= locked) { exit = true; exitReason = state === "RUNNER" ? "trailing_stop" : "stop_hit"; }
  else if (signal.direction === "SHORT" && currentPrice >= locked) { exit = true; exitReason = state === "RUNNER" ? "trailing_stop" : "stop_hit"; }
  if (signal.direction === "LONG" && currentPrice >= signal.target) { exit = true; exitReason = "tp_hit"; }
  else if (signal.direction === "SHORT" && currentPrice <= signal.target) { exit = true; exitReason = "tp_hit"; }

  return { signalId: signal.id, newState: exit ? "EXITED" : state, lockedStop: locked, profitLockActive: profitLock, highestPrice: highest, lowestPrice: lowest, exitTriggered: exit, exitReason: exitReason || undefined };
}

export function isSignalStillValid(signal: Signal, currentPrice: number, now: number = Date.now()): ValidityCheck {
  if (signal.exited || hasExited(signal.id)) return { valid: false, reason: "already_exited", exited: true };
  if (signal.direction === "LONG" && currentPrice <= (signal.lockedStop || signal.stop)) return { valid: false, reason: "stop_hit", exited: true };
  if (signal.direction === "SHORT" && currentPrice >= (signal.lockedStop || signal.stop)) return { valid: false, reason: "stop_hit", exited: true };
  if (signal.direction === "LONG" && currentPrice >= signal.target) return { valid: false, reason: "tp_hit", exited: true };
  if (signal.direction === "SHORT" && currentPrice <= signal.target) return { valid: false, reason: "tp_hit", exited: true };
  return { valid: true, reason: "active", exited: false };
}

export async function shouldHold(signal: Signal, candles4h: Candle[], currentPrice: number, now?: number): Promise<HoldResult> {
  if (signal.exited || hasExited(signal.id)) return { shouldHold: false, reason: "already_exited" };

  const tmUpdate = updateTradeManager(signal, currentPrice);
  if (tmUpdate.exitTriggered) {
    if (now) await recordExit(signal.id, signal.pair, signal.direction, currentPrice, tmUpdate.exitReason || "trade_manager_exit", now);
    return { shouldHold: false, reason: tmUpdate.exitReason || "trade_manager_exit", managedStop: tmUpdate.lockedStop || undefined };
  }

  const candles1d = aggregateTo1D(candles4h);
  try {
    const regime = await getRegime(signal.pair, candles1d, candles4h);
    if (regime.direction && regime.direction !== signal.direction) {
      const inProfit = signal.direction === "LONG" ? currentPrice > signal.entry : currentPrice < signal.entry;
      if (!inProfit) {
        if (now) await recordExit(signal.id, signal.pair, signal.direction, currentPrice, "regime_reversed_unprofitable", now);
        return { shouldHold: false, reason: "regime_reversed_unprofitable" };
      }
    }
  } catch {
    // Fallback: skip regime check on error
  }

  return { shouldHold: true, reason: "active", managedStop: tmUpdate.lockedStop || undefined };
}

export async function filterExpiredSignals(signals: Signal[], currentPrices: Record<string, number>, now?: number): Promise<{ active: Signal[]; exited: { signal: Signal; reason: string }[] }> {
  const active: Signal[] = [], exited: { signal: Signal; reason: string }[] = [];
  for (const signal of signals) {
    if (signal.exited || hasExited(signal.id)) continue;
    const price = currentPrices[signal.pair];
    if (price === undefined) { active.push(signal); continue; }
    const tmUpdate = updateTradeManager(signal, price);
    if (tmUpdate.exitTriggered) {
      exited.push({ signal, reason: tmUpdate.exitReason || "trade_manager" });
      if (now) await recordExit(signal.id, signal.pair, signal.direction, price, tmUpdate.exitReason || "trade_manager", now);
      continue;
    }
    const check = isSignalStillValid(signal, price, now);
    if (check.valid) active.push(signal);
    else { exited.push({ signal, reason: check.reason }); if (now) await recordExit(signal.id, signal.pair, signal.direction, price, check.reason, now); }
  }
  return { active, exited };
}

// ─── UI Helpers: get regime without async (reads from cache) ───

export function getCurrentRegime(pair: string): MarketRegime | null {
  return getRegimeSync(pair);
}

export function isSignalStillValidBool(signal: Signal, currentPrice: number): boolean {
  return isSignalStillValid(signal, currentPrice).valid;
}
