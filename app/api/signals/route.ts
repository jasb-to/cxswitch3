import { getLatestSignalSnapshots } from "@/lib/persistence";
import type { Signal } from "@/lib/strategy";

export const runtime = "nodejs";

export async function GET() {
  try {
    // READ-ONLY: Fetch latest signal snapshots from in-memory storage
    const snapshots = await getLatestSignalSnapshots();

    // Transform snapshots directly to Signal format (no transformation loss)
    const signals: Signal[] = snapshots.map((snapshot) => ({
      symbol: snapshot.symbol,
      price: snapshot.price,
      isBuilding: snapshot.isBuilding,
      isSniper: snapshot.isSniper,
      bias: snapshot.bias,
      confidence: snapshot.confidence,
      adx: snapshot.adx,
      stochK: snapshot.stochK,
      stochD: snapshot.stochD,
      reason: snapshot.reason,
      updatedAt: snapshot.updatedAt,
    }));

    // Debug logging
    console.log(`[API] Returning ${signals.length} signals:`);
    signals.forEach((s) => {
      console.log(
        `[API]   ${s.symbol}: isBuilding=${s.isBuilding}, isSniper=${s.isSniper}, ADX=${s.adx.toFixed(1)}, K=${s.stochK.toFixed(1)}, Confidence=${s.confidence}%`
      );
    });

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
