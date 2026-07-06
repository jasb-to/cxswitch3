// app/api/signals/route.ts — v28 "Dashboard API with Trade Manager sync"
// ============================================================
// CRITICAL FIXES:
//   - Uses lib/kraken.ts (no more duplicated fetch logic)
//   - Uses strategy.ts getMarketSnapshot() instead of duplicating indicators
//   - Fixed shouldHold() passes candles4h (not 1h)
//   - Syncs trade snapshot from strategy state
//   - Efficient: fetches 1H + 4H once per pair, no double-fetch
//   - UI receives tradeSnapshot — NEVER calculates stops

import { NextResponse } from "next/server";
import { getSignals, getSignalHistory, getPairState } from "@/lib/state";
import {
  isSignalStillValid,
  shouldHold,
  getMarketSnapshot,
  getTradeSnapshot,
  FEATURE_FLAGS,
  Candle,
} from "@/lib/strategy";
import { getCandles, Symbol } from "@/lib/kraken";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const TRACKED_PAIRS: Symbol[] = ["BTC", "ETH", "SOL", "HYPE"];

export async function GET() {
  const signals = await getSignals();
  const history = await getSignalHistory();

  const currentPrices: Record<string, number> = {};
  const freshMarket: any[] =
