import { NextRequest, NextResponse } from "next/server";
import {
  fetchCandles,
  detect4HBreakout,
  computeConfidence,
  check5MConfirmation,
  type Signal,
} from "@/lib/strategy";
import {
  getSignals,
  upsertSignal,
  incrementCandleCount,
} from "@/lib/signal-store";
import { sendTelegramAlert } from "@/lib/telegram";

const SYMBOLS = ["BTC", "ETH", "SOL"];

export async function GET(req: NextRequest) {
  // Guard: if CRON_SECRET is set, require it (Vercel cron sends it automatically)
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get("authorization");
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const results: string[] = [];

  for (const symbol of SYMBOLS) {
    try {
      // Fetch candles for all timeframes in parallel
      const [candles4h, candles15m, candles5m] = await Promise.all([
        fetchCandles(symbol, 240, 100),
        fetchCandles(symbol, 15, 100),
        fetchCandles(symbol, 5, 30),
      ]);

      // ── Increment 5M candle counters for EARLY signals ──────────────────
      incrementCandleCount(symbol);

      // ── Check existing EARLY signals for confirmation / expiry ──────────
      const activeSignals = getSignals().filter((s) => s.symbol === symbol);
      for (const sig of activeSignals) {
        if (sig.state === "EARLY") {
          const { confirm, end } = check5MConfirmation(candles5m, sig);
          if (end) {
            const updated: Signal = { ...sig, state: "END" };
            upsertSignal(updated);
            results.push(`${symbol} ${sig.direction} → END (timeout)`);
            continue;
          }
          if (confirm) {
            const updated: Signal = { ...sig, state: "CONFIRMED" };
            upsertSignal(updated);
            await sendTelegramAlert(updated);
            results.push(`${symbol} ${sig.direction} → CONFIRMED`);
          }
        }

        // Refresh confidence on all active signals
        const freshConfidence = computeConfidence(candles15m, sig.direction);
        upsertSignal({ ...sig, confidence: freshConfidence });
      }

      // ── 4H breakout detection ────────────────────────────────────────────
      const breakout = detect4HBreakout(candles4h);
      if (!breakout) {
        results.push(`${symbol}: no breakout`);
        continue;
      }

      // Skip if we already have an active signal in the same direction
      const alreadyActive = getSignals().some(
        (s) => s.symbol === symbol && s.direction === breakout.direction
      );
      if (alreadyActive) {
        results.push(`${symbol} ${breakout.direction}: already active`);
        continue;
      }

      // Create new EARLY signal
      const confidence = computeConfidence(candles15m, breakout.direction);
      const newSignal: Signal = {
        symbol,
        direction: breakout.direction,
        state: "EARLY",
        entry: breakout.entry,
        sl: breakout.sl,
        tp: breakout.tp,
        confidence,
        createdAt: Date.now(),
        candlesSince: 0,
        breakoutLevel: breakout.breakoutLevel,
      };

      upsertSignal(newSignal);
      await sendTelegramAlert(newSignal);
      results.push(`${symbol} ${breakout.direction} → EARLY (entry ${breakout.entry.toFixed(2)})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[v0] Cron error for ${symbol}:`, msg);
      results.push(`${symbol}: error – ${msg}`);
    }
  }

  return NextResponse.json({ ok: true, results, runAt: new Date().toISOString() });
}
