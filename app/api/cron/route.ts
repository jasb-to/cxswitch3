import { NextRequest, NextResponse } from "next/server";
import { generateSetups, STRATEGY_VERSION } from "@/lib/strategy-v6";
import { generateTradeSignal } from "@/lib/strategy-pure";
import { formatSignalResponse, formatTelegramAlert, formatSignalForDB } from "@/lib/signal-api";
import { refreshMarketData } from "@/lib/market-data-layer";
import { fetchCandles } from "@/lib/kraken";
import { flushAlertQueue, enqueueAlert } from "@/lib/unified-alert-pipeline";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let strategyVersionLogged = false;
let executionCycleRunning = false;
let lastExecutionCycleTime = 0;
let globalCronLocked = false;

/**
 * CLEAN EXECUTION CYCLE - Single source of truth
 * Market Data → Strategy Pure → TradeSignal → API/DB/Alert
 */
async function runExecutionCycle(): Promise<{
  signals: any[];
  timeMs: number;
}> {
  if (executionCycleRunning) {
    return { signals: [], timeMs: 0 };
  }

  executionCycleRunning = true;
  const cycleStart = Date.now();

  try {
    // STEP 1: Fetch market data
    await refreshMarketData();
    const candles = await fetchCandles();

    if (!candles || candles.length === 0) {
      console.error("[EXEC_CYCLE] No candles fetched");
      return { signals: [], timeMs: Date.now() - cycleStart };
    }

    // STEP 2: Generate trade signals using pure strategy
    const symbols = ["SOLUSDT", "ETHUSDT", "BTCUSDT"];
    const signals = [];

    for (const symbol of symbols) {
      try {
        // Pure function: market data → TradeSignal (ActiveTrade or NoTrade)
        const signal = await generateTradeSignal({
          symbol,
          price: candles[symbol]?.price || 0,
          candles: candles[symbol]?.history || [],
        });

        if (!signal) continue;

        signals.push(signal);

        // STEP 3: For active trades only, enqueue alert
        if (signal.type === "ACTIVE_TRADE") {
          try {
            // Convert signal to viewmodel format for alert pipeline
            const alertPayload = {
              symbol: signal.symbol,
              signalState: "ACTIVE_SNIPER",
              direction: signal.direction,
              price: signal.entry,
              targetPrices: {
                tp1: signal.targetPrices[0],
                tp2: signal.targetPrices[1],
                sl: signal.stopLoss,
              },
              riskReward: signal.riskReward,
              structureState: signal.structure,
              htf4hTrend: signal.marketContext?.htf4h || "EVALUATING",
              execution15mState: signal.marketContext?.execution15m || "EVALUATING",
              confidence: signal.confidence,
            };
            
            enqueueAlert(alertPayload as any);
          } catch (err) {
            console.error(`[EXEC_CYCLE] Failed to enqueue alert for ${symbol}:`, err);
          }
        }
      } catch (err) {
        console.error(`[EXEC_CYCLE] Failed to generate signal for ${symbol}:`, err);
      }
    }

    const timeMs = Date.now() - cycleStart;
    console.log(`[EXEC_CYCLE] Generated ${signals.length} signals in ${timeMs}ms`);

    return { signals, timeMs };
  } finally {
    executionCycleRunning = false;
    lastExecutionCycleTime = Date.now();
  }
}

/**
 * MAIN CRON HANDLER
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const cronStart = Date.now();

  // Cron mutex
  if (globalCronLocked) {
    return NextResponse.json(
      { status: "locked", message: "Cron already running" },
      { status: 429 }
    );
  }

  globalCronLocked = true;

  try {
    // Log strategy version once at runtime
    if (!strategyVersionLogged) {
      console.log(`[CRON] Strategy version: ${STRATEGY_VERSION}`);
      strategyVersionLogged = true;
    }

    // Run execution cycle
    const { signals, timeMs } = await runExecutionCycle();

    // Format response
    const response = {
      status: "ok",
      strategy: STRATEGY_VERSION,
      signals: signals.map(s => formatSignalResponse(s)),
      executionMs: timeMs,
      totalMs: Date.now() - cronStart,
    };

    // Flush alert queue before response
    try {
      await flushAlertQueue();
    } catch (err) {
      console.error("[CRON] Alert flush error:", err);
    }

    return NextResponse.json(response);
  } catch (err) {
    console.error("[CRON] Execution error:", err);
    return NextResponse.json(
      {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  } finally {
    globalCronLocked = false;
  }
}
