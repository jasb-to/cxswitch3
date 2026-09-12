import { getCandles, krakenPairFormat, getCurrentPrice } from "@/lib/kraken";
import { evaluate1DTrend } from "@/lib/1d-trend-engine";
import { get1DTrendState, record1DTrend } from "@/lib/1d-trend-state";
import { send1DTrendFlipAlert } from "@/lib/telegram-1d-trend";
import { getActiveSignals } from "@/lib/state";
import { get4HEmaDiagnostic } from "@/lib/ema-diagnostic";

const PAIRS = ["BTC", "ETH", "SOL", "HYPE"] as const;
const API_DELAY_MS = 450;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run1DTrendExperiment(activeOverride?: any[]) {
  const started = Date.now();
  console.log("[1D EXPERIMENT] Started | reset 7-day diagnostic | frozen engine | V28 gating=OFF");

  const active = activeOverride ?? await getActiveSignals();
  const results: any[] = [];
  const dailySince = Math.floor((Date.now() - 730 * 24 * 60 * 60 * 1000) / 1000);

  for (const pair of PAIRS) {
    try {
      const daily = await getCandles(krakenPairFormat(`${pair}/USD`), 1440, dailySince);
      await sleep(API_DELAY_MS);
      const currentPrice = await getCurrentPrice(krakenPairFormat(`${pair}/USD`));
      await sleep(API_DELAY_MS);
      const c4 = await getCandles(krakenPairFormat(`${pair}/USD`), 240);
      await sleep(API_DELAY_MS);

      if (daily.length < 220) {
        console.log(`[1D EXPERIMENT] ${pair} — insufficient daily history: ${daily.length}`);
        continue;
      }

      const latestDaily = daily.at(-1)!;
      const result = evaluate1DTrend(daily);
      const before = (await get1DTrendState())[pair]?.state;
      const recorded = await record1DTrend(pair, result, active, latestDaily.timestamp);
      const fourH = get4HEmaDiagnostic(c4);
      const ageHours = (Date.now() - latestDaily.timestamp) / (60 * 60 * 1000);

      if (recorded.flip && before) {
        await send1DTrendFlipAlert(pair, before, recorded.state, result);
      }

      console.log(
        `[1D EXPERIMENT] ${pair} — ${recorded.state} | candidate=${result.candidateState} | structure=${result.structure.label} | EMA=${result.ema.alignment} | 5/13=${result.fast513.direction} | ADX=${result.adx} | momentum=${result.momentum.direction}/${result.momentum.state} | 4H 5/13=${fourH.label} | latestDaily=${new Date(latestDaily.timestamp).toISOString()} close=${latestDaily.close} ageHours=${ageHours.toFixed(2)} | ticker=${currentPrice}`
      );

      results.push({
        pair,
        state: recorded.state,
        candidate: result.candidateState,
        flip: recorded.flip,
        observationTimestamp: latestDaily.timestamp,
        price: result.price,
        currentTickerPrice: currentPrice,
        latestDailyClose: latestDaily.close,
        latestDailyTimestamp: latestDaily.timestamp,
        latestDailyAgeHours: ageHours,
        structure: result.structure,
        ema: result.ema,
        fast513: result.fast513,
        adx: result.adx,
        momentum: result.momentum,
        fourH513: fourH,
        v28Active: active.filter((x: any) => x.pair === pair),
      });
    } catch (error) {
      console.error(`[1D EXPERIMENT] ${pair} ERROR`, error);
      results.push({ pair, error: String(error) });
    }
  }

  console.log(`[1D EXPERIMENT] Done pairs=${results.length} duration=${Date.now() - started}ms | V28 untouched`);
  return {
    success: true,
    experiment: "1D frozen trend engine",
    startedAt: new Date(started).toISOString(),
    resetAt: new Date(started).toISOString(),
    v28Gating: false,
    results,
  };
}
