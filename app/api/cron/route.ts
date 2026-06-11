// app/api/cron/route.ts
import { NextResponse } from "next/server";
import { getCandles } from "@/lib/kraken";
import { generateSignal } from "@/lib/strategy";
import { setSignals, setMarketData, getActiveTrades, setActiveTrades } from "@/lib/state";
import { sendAlert } from "@/lib/telegram";

const PAIRS = ["BTC", "ETH", "SOL"] as const;
const COOLDOWN_MINUTES = 30;

function roundPrice(n: number): number {
  if (n >= 10000) return Math.round(n);
  if (n >= 1000) return Math.round(n * 10) / 10;
  if (n >= 100) return Math.round(n * 100) / 100;
  return Math.round(n * 1000) / 1000;
}

function roundIndicator(n: number): number {
  return Math.round(n * 10) / 10;
}

function roundRR(n: number): number {
  return Math.round(n * 100) / 100;
}

function roundExpectedMove(n: number): number {
  return Math.round(n * 100) / 100;
}

function isOnCooldown(trade: { direction: string; timestamp: number } | undefined): boolean {
  if (!trade) return false;
  const minutesSince = (Date.now() - trade.timestamp) / (1000 * 60);
  return minutesSince < COOLDOWN_MINUTES;
}

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  console.log("========================================");
  console.log(`[CRON] Started at ${new Date().toISOString()}`);

  const url = new URL(request.url);
  const querySecret = url.searchParams.get("secret");
  const authHeader = request.headers.get("authorization");
  const resetCooldown = url.searchParams.get("reset") === "true";

  const isAuthorized = 
    querySecret === process.env.CRON_SECRET ||
    authHeader === `Bearer ${process.env.CRON_SECRET}`;

  if (!isAuthorized) {
    console.log(`[AUTH] FAILED`);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  console.log(`[AUTH] PASSED`);

  let activeTrades = await getActiveTrades();
  
  if (resetCooldown) {
    console.log(`[STATE] Resetting all cooldowns`);
    activeTrades = {};
    await setActiveTrades({});
  }
  
  console.log(`[STATE] Active trades:`, Object.keys(activeTrades).join(", ") || "none");

  const signals: any[] = [];
  const marketDataList: any[] = [];
  const alerts: any[] = [];

  for (const pair of PAIRS) {
    console.log(`[PAIR] ${pair} — fetching candles...`);
    try {
      const candles1h = await getCandles(pair, 60);
      const candles4h = await getCandles(pair, 240);

      console.log(`[PAIR] ${pair} — 1H: ${candles1h?.length ?? 0}, 4H: ${candles4h?.length ?? 0}`);

      if (!candles1h || !candles4h || candles1h.length < 50 || candles4h.length < 50) {
        console.log(`[PAIR] ${pair} — SKIP: insufficient candles`);
        alerts.push({ pair, status: "skip", reason: "insufficient candles" });
        continue;
      }

      const result = await generateSignal(pair, candles1h, candles4h, activeTrades);

      let signal: any = null;
      let market: any = null;

      if (result && typeof result === "object") {
        if ("signal" in result && "market" in result) {
          signal = result.signal;
          market = result.market;
        } else if ("pair" in result) {
          signal = result;
        }
      }

      if (market) {
        marketDataList.push(market);
      }

      if (!signal || !signal.pair) {
        console.log(`[PAIR] ${pair} — NO SIGNAL`);
        alerts.push({ pair, status: "no_signal" });
        continue;
      }

      // Check cooldown before alerting
      const existingTrade = activeTrades[pair];
      if (isOnCooldown(existingTrade) && existingTrade?.direction === signal.direction) {
        console.log(`[PAIR] ${pair} — COOLDOWN: ${signal.direction} active for ${((Date.now() - existingTrade.timestamp) / 60000).toFixed(1)} min`);
        alerts.push({ pair, status: "cooldown", direction: signal.direction });
        continue;
      }

      console.log(`[PAIR] ${pair} — SIGNAL: ${signal.direction} ${signal.type} conf=${signal.confidence}% ADX=${signal.adx.toFixed(1)}`);
      signals.push(signal);

      console.log(`[ALERT] ${pair} — sending alert...`);

      const alertPayload = {
        symbol: signal.pair,
        state: signal.type,
        price: roundPrice(signal.entry),
        bias: signal.direction,
        confidence: signal.confidence,
        stopLoss: roundPrice(signal.stop),
        takeProfit: roundPrice(signal.target),
        rr: roundRR(signal.rr),
        adx: roundIndicator(signal.adx),
        rsi: roundIndicator(signal.rsi),
        stochK: roundIndicator(signal.stochK),
        stochD: roundIndicator(signal.stochD),
        expectedMove: roundExpectedMove(signal.expectedMove),
        reason: signal.reason,
        updatedAt: new Date(signal.timestamp).toISOString(),
      };

      console.log(`[ALERT] Payload:`, JSON.stringify(alertPayload, null, 2));

      try {
        await sendAlert(alertPayload);
        console.log(`[ALERT] ${pair} — SENT`);

        activeTrades[pair] = {
          direction: signal.direction,
          timestamp: Date.now(),
        };

        alerts.push({ pair, status: "sent" });
      } catch (alertErr) {
        console.error(`[ALERT] ${pair} — FAILED:`, alertErr);
        alerts.push({ pair, status: "alert_failed", error: String(alertErr) });
      }

    } catch (err) {
      console.error(`[PAIR] ${pair} — ERROR:`, err);
      alerts.push({ pair, status: "error", error: err instanceof Error ? err.message : "Unknown" });
    }
  }

  console.log(`[STATE] Saving ${signals.length} signals, ${marketDataList.length} market data...`);
  await setSignals(signals);
  await setMarketData(marketDataList);
  await setActiveTrades(activeTrades);
  console.log(`[CRON] Done. signals=${signals.length}, marketData=${marketDataList.length}`);
  console.log("========================================");

  return NextResponse.json({
    success: true,
    timestamp: new Date().toISOString(),
    signals: signals.length,
    marketData: marketDataList.length,
    alerts,
  });
}
