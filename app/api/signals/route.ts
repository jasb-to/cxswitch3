import { getLatestSignalSnapshots } from "@/lib/persistence";

export const runtime = "nodejs";

export async function GET() {
  try {
    const signals = await getLatestSignalSnapshots();

    const safeSignals = Array.isArray(signals) ? signals : [];

    console.log(
      `[API] Returning ${safeSignals.length} signals from persistence layer`
    );

    return Response.json({
      signals: safeSignals,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[API] ERROR:", err);

    return Response.json({
      signals: [],
      error: "Failed to load signals",
    });
  }
}
