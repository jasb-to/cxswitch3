import { getSignalHistory } from "@/lib/persistence";

export const runtime = "nodejs";

export async function GET() {
  try {
    // pull all symbols from persistence safely
    const symbols = ["BTC", "ETH", "SOL"];

    const signals = symbols
      .map((symbol) => {
        const history = getSignalHistory(symbol);

        if (!history || history.length === 0) return null;

        return history[history.length - 1];
      })
      .filter(Boolean);

    console.log(
      `[API] Returning ${signals.length} signals from persistence layer`
    );

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
