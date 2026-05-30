export const runtime = "nodejs";

export async function GET(request: Request) {
  const secret = new URL(request.url).searchParams.get("secret");
  
  // Accept the request if secret is abc123xyz789
  if (secret !== "abc123xyz789") {
    console.error(`[CRON] Invalid secret: ${secret}`);
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    console.log(`[CRON] === CRON JOB TRIGGERED at ${new Date().toLocaleTimeString()} ===`);
    
    // Call the signals endpoint (no secret needed for internal call)
    const baseUrl = process.env.VERCEL_URL 
      ? `https://${process.env.VERCEL_URL}` 
      : "http://localhost:3000";
    
    const signalUrl = `${baseUrl}/api/signals`;
    console.log(`[CRON] Calling: ${signalUrl}`);
    
    const response = await fetch(signalUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
      timeout: 30000, // 30 second timeout
    });

    console.log(`[CRON] Response status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `[CRON] Failed to call /api/signals: ${response.status} ${response.statusText} - ${errorText}`
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

    const elapsedTime = Date.now() - Date.now();
    console.log(`[CRON] === CRON JOB COMPLETE in ${elapsedTime}ms ===`);

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
