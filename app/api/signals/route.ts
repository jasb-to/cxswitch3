import { getLatestSignalSnapshots } from "@/lib/persistence";

export const runtime = "nodejs";

export async function GET() {
  try {
    // READ-ONLY: Fetch latest signal snapshots from in-memory storage
    const snapshots = await getLatestSignalSnapshots();

    // Transform snapshots to Signal format for UI compatibility
    const signals = snapshots.map((snapshot) => ({
      symbol: snapshot.symbol,
      price: snapshot.price,
      state: snapshot.state,
      bias: snapshot.bias,
      confidence: snapshot.confidence,
      adx: 0,
      stochK: 0,
      stochD: 0,
      reason: snapshot.structure,
      updatedAt: snapshot.updatedAt,
    }));

    return Response.json(
      { signals, updatedAt: new Date().toISOString() },
      {
        headers: {
          "Cache-Control": "public, max-age=5, s-maxage=5",
        },
      }
    );
  } catch (err) {
    console.error(`[API] Error:`, err);
    return Response.json(
      { error: "Failed to fetch signals", signals: [] },
      { status: 500, headers: { "Cache-Control": "no-cache" } }
    );
  }
}
