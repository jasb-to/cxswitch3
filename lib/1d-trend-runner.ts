import { getCandles, krakenPairFormat } from "@/lib/kraken";
import { evaluate1DTrend } from "@/lib/1d-trend-engine";
import { record1DUnavailable, record1DTrend } from "@/lib/1d-trend-state";
import { getActiveSignals } from "@/lib/state";

const PAIRS = ["BTC", "ETH", "SOL", "HYPE", "DOGE", "LINK", "AVAX", "ZEC"] as const;


export async function run1DTrendExperiment(activeOverride?: any[]) {
  const started = Date.now();
  const active = activeOverride ?? await getActiveSignals();
  const results: any[] = [];
  const dailySince = Math.floor((Date.now() - 730 * 24 * 60 * 60 * 1000) / 1000);

  for (const pair of PAIRS) {
    try {
      const daily = await getCandles(krakenPairFormat(pair + "/USD"), 1440, dailySince);
      const minimumDailyCandles = 220;}