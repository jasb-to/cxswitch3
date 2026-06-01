import { generateAndStoreSignals } from "@/lib/signalEngine";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const startTime = Date.now();

  try {
    console.log(
      `[CRON] ════════════════════════════════════════════════════════════`
    );
    console.log(`[CRON] STARTED at ${new Date().toLocaleString()}`);

    const result = await generateAndStoreSignals();

    // ✅ HARD GUARD: NEVER trust engine output
    const signals = Array.isArray(result)
      ? result
      : result && typeof result === "object"
      ? Object.values(result)
      : [];

    if (!Array.isArray(signals)) {
      throw new Error("Signals normalization failed");
    }

    console.log(
      `[CRON] COMPLETE in ${Date.now() - startTime}ms | Signals: ${
        signals.length
      }`
    );

    return Response.json({
      success: true,
      signalsCount: signals.length,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[CRON ERROR]", err);

    return Response.json(
      {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        signalsCount: 0,
      },
      { status: 500 }
    );
  }
}
