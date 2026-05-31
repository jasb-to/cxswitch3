import { getLatestSignalSnapshots } from "@/lib/persistence";
import type { Signal } from "@/lib/strategy";

export const runtime = "nodejs";

export async function GET() {
  try {
    const snapshots = await getLatestSignalSnapshots();

    const safeSnapshots = Array.isArray(snapshots) ? snapshots : [];

    const signals: Signal[] = safeSnapshots.map((snapshot) => ({
      symbol: snapshot.symbol,
      price: Number(snapshot.price ?? 0),
      isSetupValid: Boolean(snapshot.isSetupValid),
      isSniperCandidate: Boolean(snapshot.isSniperCandidate),
      isSniper: Boolean(snapshot.isSniper),
      bias: snapshot.bias ?? "Neutral",
      confidence: Number(snapshot.confidence ?? 0),
      adx: Number(snapshot.adx ?? 0),
      stochK: Number(snapshot.stochK ?? 0),
      stochD: Number(snapshot.stochD ?? 0),
      reason: snapshot.reason ?? "UNKNOWN",
      stopLoss: snapshot.stopLoss ?? null,
      takeProfit: snapshot.takeProfit ?? null,
      riskRewardRatio: snapshot.riskRewardRatio ?? null,
      updatedAt: snapshot.updatedAt ?? new Date().toISOString(),
    }));

    console.log(`[API] ========== EXECUTION GATE VALIDATION ==========`);
    console.log(`[API] Returning ${signals.length} signals from persistence layer`);

    const safeGet = (n: any, digits: number) =>
      typeof n === "number" && !isNaN(n) ? n.toFixed(digits) : "0.00";

    ["BTC", "ETH", "SOL"].forEach((symbolName) => {
      const signal = signals.find((s) => s.symbol === symbolName);

      if (!signal) {
        console.log(`[API] ${symbolName}: NOT IN SNAPSHOTS`);
        return;
      }

      console.log(`[API] ${symbolName}:`);
      console.log(
        `[API]   Setup: ${signal.isSetupValid}, Candidate: ${signal.isSniperCandidate}, Execution: ${signal.isSniper}`
      );

      console.log(
        `[API]   Price: $${safeGet(signal.price, 2)}, ADX: ${safeGet(
          signal.adx,
          1
        )}, Bias: ${signal.bias}`
      );

      if (signal.isSniper) {
        console.log(
          `[API]   🟢 SNIPER APPROVED - SL: $${safeGet(
            signal.stopLoss,
            2
          )}, TP: $${safeGet(signal.takeProfit, 2)}, RRR: ${
            signal.riskRewardRatio ?? 0
          }`
        );
      } else if (signal.isSetupValid) {
        console.log(
          `[API]   🟡 SETUP ACTIVE - Awaiting trigger (SL/TP: null)`
        );
      } else {
        console.log(`[API]   ⚪ MONITORING - No setup (SL/TP: null)`);
      }
    });

    console.log(`[API] ========== END VALIDATION ==========`);

    return Response.json(
      { signals, updatedAt: new Date().toISOString() },
      {
        headers: {
          "Cache-Control": "public, max-age=5, s-maxage=5",
        },
      }
    );
  } catch (err) {
    console.error(`[API] Error:`, err);

    return Response.json(
      { error: "Failed to fetch signals", signals: [] },
      {
        status: 500,
        headers: { "Cache-Control": "no-cache" },
      }
    );
  }
}
