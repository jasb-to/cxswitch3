export async function GET() {
  try {
    const signals = await getLatestSignalSnapshots();

    const safeSignals = (signals || [])
      .filter(Boolean)
      .map((s) => ({
        symbol: s.symbol ?? "UNKNOWN",
        price: Number(s.price ?? 0),

        state: s.state ?? "WAIT",

        isEarly: Boolean(s.isEarly),
        isSniper: Boolean(s.isSniper),
        isActive: Boolean(s.isActive),

        bias: s.bias ?? "Neutral",
        confidence: Number(s.confidence ?? 0),

        adx: Number(s.adx ?? 0),
        stochK: Number(s.stochK ?? 0),
        stochD: Number(s.stochD ?? 0),

        reason: s.reason ?? "",

        stopLoss: s.stopLoss ?? null,
        takeProfit: s.takeProfit ?? null,
        riskRewardRatio: s.riskRewardRatio ?? null,

        updatedAt: s.updatedAt ?? new Date().toISOString(),
      }));

    console.log(
      `[API] Returning ${safeSignals.length} signals from persistence layer`
    );

    return Response.json({
      signals: safeSignals,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[API] ERROR:", err);

    return Response.json(
      { signals: [], error: "Failed to load signals" },
      { status: 500 }
    );
  }
}
