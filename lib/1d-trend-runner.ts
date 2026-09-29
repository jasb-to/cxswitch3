import { getCandles, krakenPairFormat } from "@/lib/kraken";
import { getPaidAggregatedDailyCandles } from "@/lib/geckoterminal";
import { evaluate1DTrend } from "@/lib/1d-trend-engine";
import { get1DTrendState, record1DTrend } from "@/lib/1d-trend-state";
import { getActiveSignals } from "@/lib/state";

const PAIRS = ["BTC", "ETH", "SOL", "HYPE", "DOGE", "LINK", "AVAX", "PAID"] as const;


export async function run1DTrendExperiment(activeOverride?: any[]) {
  const started = Date.now();
  const active = activeOverride ?? await getActiveSignals();
  const results: any[] = [];
  const dailySince = Math.floor((Date.now() - 730 * 24 * 60 * 60 * 1000) / 1000);

  for (const pair of PAIRS) {
    try {
      const daily = pair === "PAID"
        ? await getPaidAggregatedDailyCandles()
        : await getCandles(krakenPairFormat(`${pair}/USD`), 1440, dailySince);

      // PAID is a young pool. Its real 4H history is aggregated into complete
      // daily candles, so use the available-history floor for PAID only.
      const minimumDailyCandles = pair === "PAID" ? 180 : 220;
      if (daily.length < minimumDailyCandles) {
        console.log(`[1D] ${pair} | INSUFFICIENT daily=${daily.length} required=${minimumDailyCandles}`);
        continue;
      }

      const latestDaily = daily.at(-1)!;
      const result = evaluate1DTrend(daily);
      const recorded = await record1DTrend(pair, result, active, latestDaily.timestamp);
      const ageHours = (Date.now() - latestDaily.timestamp) / (60 * 60 * 1000);
      const flip = recorded.flip ? ` | FLIP=${recorded.state}` : "";

      // One compact line per asset. The 1D engine is context for V28, not a separate alert engine.
      console.log(`[1D] ${pair} | ${recorded.state}/${result.candidateState} | ${result.structure.label} | EMA=${result.ema.alignment} | 5/13=${result.fast513.direction} | ADX=${result.adx} | MOM=${result.momentum.direction}/${result.momentum.state}${flip}`);

      results.push({
        pair,
        state: recorded.state,
        candidate: result.candidateState,
        flip: recorded.flip,
        observationTimestamp: latestDaily.timestamp,
        price: result.price,
        currentTickerPrice: latestDaily.close,
        latestDailyClose: latestDaily.close,
        latestDailyTimestamp: latestDaily.timestamp,
        latestDailyAgeHours: ageHours,
        structure: result.structure,
        ema: result.ema,
        fast513: result.fast513,
        adx: result.adx,
        momentum: result.momentum,
        v28Active: active.filter((x: any) => x.pair === pair),
      });
    } catch (error) {
      console.error(`[1D] ${pair} ERROR`, error);
      results.push({ pair, error: String(error) });
    }
  }

  console.log(`[1D] DONE pairs=${results.length} duration=${Date.now() - started}ms`);
  return {
    success: true,
    experiment: "1D frozen trend engine",
    startedAt: new Date(started).toISOString(),
    resetAt: new Date(started).toISOString(),
    v28Gating: true,
    results,
  };
}