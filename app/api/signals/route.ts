import { getLatestSignalSnapshots } from "@/lib/persistence";

export const runtime = "nodejs";

export async function GET() {
  console.log(`[API] === SIGNALS API CALLED at ${new Date().toLocaleTimeString()} ===`);

  try {
    // READ-ONLY: Fetch latest persisted signal snapshots (no computation, no alerts)
    const snapshots = await getLatestSignalSnapshots();

    // Transform snapshots back to Signal format for UI compatibility
    const signals = snapshots.map((snapshot) => ({
      symbol: snapshot.symbol,
      price: snapshot.price,
      state: snapshot.state, // Now using WATCHING_SHIFT, BUILDING, SNIPER
      bias: snapshot.bias,
      confidence: snapshot.confidence,
      adx: 0, // Not stored in snapshot, but API returns it for UI
      stochK: 0, // Not stored in snapshot
      stochD: 0, // Not stored in snapshot
      reason: snapshot.structure,
      updatedAt: snapshot.updatedAt,
    }));

    console.log(
      `[API] Returned ${signals.length} signals from persistent storage`
    );

    return Response.json(
      { signals, updatedAt: new Date().toISOString() },
      {
        headers: {
          "Cache-Control": "public, max-age=10, s-maxage=10",
        },
      }
    );
  } catch (err) {
    console.error(`[API] Fatal error:`, err);
    return Response.json(
      { error: "Failed to fetch signals", signals: [] },
      {
        status: 500,
        headers: {
          "Cache-Control": "no-cache",
        },
      }
    );
  }
}
