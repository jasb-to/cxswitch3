import { generateAndStoreSignals } from "@/lib/signalEngine";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const secret = new URL(request.url).searchParams.get("secret");

  // =========================
  // AUTH CHECK
  // =========================
  if (secret !== "abc123xyz789") {
    const msg = `[CRON] UNAUTHORIZED: Invalid secret provided`;
    console.error(msg);

    return new Response(
      JSON.stringify({ success: false, error: msg }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }
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
    // ENGINE EXECUTION
    // =========================
    const result = await generateAndStoreSignals();

    // 🔒 HARD GUARD: engine MUST NOT break cron
    const signals = Array.isArray(result) ? result : [];

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

    console.error(
      `[CRON] ════════════════════════════════════════════════════════════`
    );
    console.error(`[CRON] FATAL ERROR after ${duration}ms: ${errorMsg}`);
    console.error(
      `[CRON] Stack:`,
      err instanceof Error ? err.stack : "N/A"
    );
    console.error(
      `[CRON] ════════════════════════════════════════════════════════════`
    );

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
