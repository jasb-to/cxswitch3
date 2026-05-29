export const runtime = "nodejs";

export async function GET(request: Request) {
  const secret = new URL(request.url).searchParams.get("secret");
  
  // Verify cron secret for security
  if (secret !== process.env.CRON_SECRET) {
    console.error("[CRON] Invalid cron secret");
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    console.log(`[CRON] === CRON JOB TRIGGERED at ${new Date().toLocaleTimeString()} ===`);
    
    // Call the signals endpoint to generate and send alerts
    const baseUrl = process.env.VERCEL_URL 
      ? `https://${process.env.VERCEL_URL}` 
      : "http://localhost:3000";
    
    const response = await fetch(`${baseUrl}/api/signals?secret=${encodeURIComponent(process.env.CRON_SECRET || "")}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.error(
        `[CRON] Failed to call /api/signals: ${response.status} ${response.statusText}`
      );
      return new Response(
        `Failed to generate signals: ${response.statusText}`,
        { status: response.status }
      );
    }

    const data = await response.json();
    console.log(
      `[CRON] ✅ Successfully generated ${data.signals?.length || 0} signals`
    );

    return new Response(
      JSON.stringify({
        success: true,
        message: "Signals generated successfully",
        signalCount: data.signals?.length || 0,
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
