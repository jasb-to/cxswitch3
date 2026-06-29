// lib/strategy.ts — v31.1 "Cascading pivots + wider compression + transition setup"
// ============================================================
// Fixes:
// 1. Cascading pivot window: tries ±5, ±3, ±2 — picks best R²
// 2. Wider COMPRESSION zone: 4% (was 2.5%) for choppy markets
// 3. Transition setup: when 1D/4H disagree, allow retest from wider distance
// 4. Fallback pivot detection for smooth trends (HYPE-style ramps)

import { getTrendlineState, setTrendlineState } from "@/lib/state";

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Signal {
  id: string;
  pair: string;
  direction: "LONG" | "SHORT";
  type: "ACCUMULATE" | "BREAKOUT";
  scale: "ENTRY_1" | "ADD";
  entry: number;
  stop: number;
  target: number;
  confidence: number;
  rr: number;
  adx: number;
  rsi: number;
  stochK: number;
  stochD: number;
  expectedMove: number;
  reason: string;
  timestamp: number;
  version: number;
}

export interface SignalResult {
  signal?: Signal;
  market?: any;
  debug: string[];
}

export const CURRENT_SIGNAL_VERSION = 31;

// --- CONFIG ---
const MIN_RR = 1.5;
const TL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ADX_EXHAUSTION = 45;
const STOCH_EXTREME_LONG = 85;
const STOCH_EXTREME_SHORT = 15;
const CORRECT_SIDE_BUFFER = 0.015;
const TL_MAX_DIST = 0.05; // 5%
const MAX_PIVOT_AGE_CANDLES = 120;

// Regime-specific thresholds
const MIN_R2_TREND = 0.55;
const MIN_R2_COMPRESSION = 0.20;

// Setup zones
const TREND_ZONE = 0.015; // 1.5%
const COMPRESSION_ZONE = 0.04; // 4% (was 2.5%)
const TRANSITION_ZONE = 0.06; // 6% when 1D/4H disagree

// --- STATE ---
interface TrendlineState {
  pivots: { index: number; price: number; timestamp: number }[];
  lastUpdated: number;
  direction: "LONG" | "SHORT";
}

const trendlineStore: Map<string, TrendlineState> = new Map();

export async function loadTrendlinesFromKV(): Promise<void> {
  const state = await getTrendlineState();
  if (state) {
    for (const [key, value] of Object.entries(state)) {
      trendlineStore.set(key, value as TrendlineState);
    }
  }
}

export async function saveTrendlinesToKV(): Promise<void> {
  const obj: Record<string, Trend
