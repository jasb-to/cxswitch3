import { getLatestSignalSnapshots } from "@/lib/persistence";

export const runtime = "nodejs";

export async function GET() {
  try {
    const signals = await getLatestSignalSnapshots();

    console.log(
      `[API] Returning ${signals.length} signals from persistence layer`
    );

    // IMPORTANT: DO NOT RE-CALCULATE STATE HERE
    return Response.json({
      signals,
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
