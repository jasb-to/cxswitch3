import { generateAndStoreSignals } from "@/lib/signalEngine";

export const runtime = "nodejs";

const SYMBOLS = ["BTC", "ETH", "SOL"];

const PRICES: Record<string, number> = {
  BTC: 71000,
  ETH: 2000,
  SOL: 80,
};

export async function GET() {
  const start = Date.now();

  try {
    console.log("══════════════════════════════════════");
    console.log("[CRON] STARTED", new Date().toISOString());

    if (!Array.isArray(SYMBOLS) || SYMBOLS.length === 0) {
      throw new Error("SYMBOLS missing or invalid");
    }

    const prices = SYMBOLS.map((s) => PRICES[s] ?? 0);

    const signals = await generateAndStoreSignals(SYMBOLS, prices);

    // =========================
    // 🔥 TRADE LOG OUTPUT (IMPORTANT)
    // =========================
    console.log("========== TRADE SIGNALS ==========");

    signals.forEach((s) => {
      console.log(
        `[${s.symbol}] ${s.state} | $${s.price} | Bias: ${s.bias} | Conf: ${s.confidence}%`
      );

      if (s.state === "SNIPER") {
        console.log(
          `>>> TRADE SETUP: ${s.symbol}
ENTRY: ${s.price}
SL: ${s.stopLoss}
TP: ${s.takeProfit}
R/R: ${s.riskRewardRatio}
REASON: ${s.reason}`
        );
      }
    });

    console.log("===================================");

    const duration = Date.now() - start;

    console.log(
      `[CRON] COMPLETE in ${duration}ms | Signals: ${signals.length}`
    );

    return Response.json({
      ok: true,
      signalsCount: signals.length,
      runtimeMs: duration,
    });
  } catch (err: any) {
    console.error("[CRON ERROR]", err?.message || err);

    return Response.json(
      {
        ok: false,
        error: "CRON_FAILED",
      },
      { status: 500 }
    );
  }
}
