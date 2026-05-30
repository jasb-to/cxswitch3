import { generateAndStoreSignals } from "@/lib/signalEngine";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const secret = new URL(request.url).searchParams.get("secret");

  // Verify secret
  if (secret !== "abc123xyz789") {
    console.error(`[CRON] Invalid secret: ${secret}`);
    return new Response("Unauthorized", { status: 401 });
  }

  const startTime = Date.now();
  console.log(`[CRON] === CRON JOB TRIGGERED at ${new Date().toLocaleTimeString()} ===`);

  try {
    // Single source of truth for signal generation
    const signals = await generateAndStoreSignals();

    const duration = Date.now() - startTime;
    console.log(
      `[CRON] === CRON JOB COMPLETE in ${duration}ms | Processed ${signals.length} signals ===`
    );

    return new Response(
      JSON.stringify({
        success: true,
        message: "Signals processed",
        signalCount: signals.length,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error(`[CRON] Fatal error:`, err);
    return new Response(
      JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
