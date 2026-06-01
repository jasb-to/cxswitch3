import { getLatestSignalSnapshots } from "@/lib/persistence";

export const runtime = "nodejs";

export async function GET() {
  try {
    const raw = await getLatestSignalSnapshots();

    const signals = Array.isArray(raw) ? raw : [];

    // 🔥 NORMALISE DATA (prevents UI crashes)
    const safeSignals = signals.map((s) => ({
      symbol: s?.symbol ?? "—",
      price: Number(s?.price ?? 0),

      state: s?.state ?? "WAIT",

      isEarly: Boolean(s?.isEarly),
      isSniper: Boolean(s?.isSniper),
      isActive: Boolean(s?.isActive),

      bias: s?.bias ?? "Neutral",
      confidence: Number(s?.confidence ?? 0),

      adx: Number(s?.adx ?? 0),
      stochK: Number(s?.stochK ?? 0),
      stochD: Number(s?.stochD ?? 0),

      reason: s?.reason ?? "",

      stopLoss:
        typeof s?.stopLoss === "number" ? s.stopLoss : null,
      takeProfit:
        typeof s?.takeProfit === "number" ? s.takeProfit : null,
      riskRewardRatio:
        typeof s?.riskRewardRatio === "number"
          ? s.riskRewardRatio
          : null,

      updatedAt: s?.updatedAt ?? new Date().toISOString(),
    }));

    console.log(
      `[API] Returning ${safeSignals.length} safe signals`
    );

    return Response.json({
      signals: safeSignals,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[API] ERROR:", err);

    return Response.json({
      signals: [],
      error: "SIGNALS_API_FAILED",
    });
  }
}
