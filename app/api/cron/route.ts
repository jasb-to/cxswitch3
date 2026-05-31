import { generateAndStoreSignals } from "@/lib/signalEngine";
import { getLatestSignalSnapshots } from "@/lib/persistence";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const secret = new URL(request.url).searchParams.get("secret");

  // =========================
  // AUTH CHECK
  // =========================
  if (secret !== "abc123xyz789") {
    console.error("[CRON] UNAUTHORIZED");

    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized" }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const startTime = Date.now();

  console.log(
    "[CRON] ════════════════════════════════════════════════════════════"
  );
  console.log(`[CRON] STARTED at ${new Date().toLocaleString()}`);
  console.log(
    "[CRON] ════════════════════════════════════════════════════════════"
  );

  try {
    // =========================
    // GET LATEST MARKET STATE
    // =========================
    const latestSnapshots = await getLatestSignalSnapshots();

    // =========================
    // NORMALISE FOR ENGINE
    // =========================
    const engineInput = latestSnapshots.map((snap) => ({
      symbol: snap.symbol,
      candles4H: [], // (not wired yet)
      candles1H: [],
      candles15M: [],
      price: snap.price,
    }));

    // =========================
    // SAFETY CHECK
    // =========================
    if (!engineInput.length) {
      console.log("[CRON] No snapshots available");

      return new Response(
        JSON.stringify({
          success: true,
          message: "No data to process",
          signalCount: 0,
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // =========================
    // RUN ENGINE
    // =========================
    const result = await generateAndStoreSignals(engineInput);

    const signals = Array.isArray(result?.signals)
      ? result.signals
      : [];

    const duration = Date.now() - startTime;

    const msg = `CRON COMPLETE in ${duration}ms: Processed ${signals.length} signals`;

    console.log(
      "[CRON] ════════════════════════════════════════════════════════════"
    );
    console.log(`[CRON] ${msg}`);
    console.log(
      "[CRON] ════════════════════════════════════════════════════════════"
    );

    return new Response(
      JSON.stringify({
        success: true,
        message: msg,
        signalCount: signals.length,
        executionTime: duration,
      }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    const duration = Date.now() - startTime;

    const errorMsg =
      err instanceof Error ? err.message : String(err);

    console.error(`[CRON] FATAL ERROR after ${duration}ms: ${errorMsg}`);
    console.error(err);

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
