import { generateAndStoreSignals } from "@/lib/signalEngine";
import { getPersistence } from "@/lib/persistence";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const secret = new URL(request.url).searchParams.get("secret");

  // =========================
  // AUTH CHECK
  // =========================
  if (secret !== "abc123xyz789") {
    console.error(`[CRON] UNAUTHORIZED: Invalid secret`);

    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  const startTime = Date.now();

  console.log(
    `[CRON] ════════════════════════════════════════════════════════════`
  );
  console.log(`[CRON] CRON JOB STARTED at ${new Date().toLocaleString()}`);
  console.log(
    `[CRON] ════════════════════════════════════════════════════════════`
  );

  try {
    // =========================
    // LOAD MARKET DATA FIRST
    // =========================
    const raw = await getPersistence();

    const engineInput = Object.entries(raw ?? {}).map(
      ([symbol, value]: any) => ({
        symbol,
        candles4H: value?.candles4H ?? [],
        candles1H: value?.candles1H ?? [],
        candles15M: value?.candles15M ?? [],
        price: value?.price ?? 0,
      })
    );

    // =========================
    // SAFETY CHECK
    // =========================
    if (!engineInput.length) {
      console.log("[CRON] No data available");
      return new Response(
        JSON.stringify({
          success: true,
          message: "No data to process",
          signalCount: 0,
        })
      );
    }

    // =========================
    // ENGINE EXECUTION (FIXED)
    // =========================
    const result = await generateAndStoreSignals(engineInput);

    const signals = Array.isArray(result?.signals)
      ? result.signals
      : [];

    const duration = Date.now() - startTime;

    const msg = `CRON JOB COMPLETE in ${duration}ms: Processed ${signals.length} signals`;

    console.log(
      `[CRON] ════════════════════════════════════════════════════════════`
    );
    console.log(`[CRON] ${msg}`);
    console.log(
      `[CRON] ════════════════════════════════════════════════════════════`
    );

    return new Response(
      JSON.stringify({
        success: true,
        message: msg,
        signalCount: signals.length,
        executionTime: duration,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    const duration = Date.now() - startTime;

    const errorMsg =
      err instanceof Error ? err.message : String(err);

    console.error(`[CRON] FATAL ERROR after ${duration}ms: ${errorMsg}`);
    console.error(`[CRON] Stack:`, err instanceof Error ? err.stack : "N/A");

    return new Response(
      JSON.stringify({
        success: false,
        error: errorMsg,
        executionTime: duration,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
