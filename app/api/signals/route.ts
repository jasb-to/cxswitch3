import { getLatestSignalSnapshots } from "@/lib/persistence";

export const runtime = "nodejs";

export async function GET() {
  try {
    const raw = await getLatestSignalSnapshots();

    const signals = Array.isArray(raw)
      ? raw.filter(Boolean)
      : [];

    return Response.json({
      signals,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[API] ERROR:", err);

    return Response.json(
      {
        signals: [],
        error: "Failed to load signals",
      },
      { status: 500 }
    );
  }
}
