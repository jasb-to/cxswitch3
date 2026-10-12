import { NextResponse } from "next/server";
import { getActiveSignals, setActiveSignals, getSignalHistory, setSignalHistory } from "@/lib/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAIRS = new Set(["BTC", "ETH", "SOL", "HYPE", "LINK", "VIRTUAL", "DOGE", "ZEC"]);
const MAX_CONFIRM_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// A signal becomes a managed manual position only after the user confirms
// they actually entered it. Merely receiving an alert never creates a trade.
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const pair = String(body?.pair || "").toUpperCase();
    if (!PAIRS.has(pair)) return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });

    const history = await getSignalHistory();
    const latest = history
      .filter((h: any) => h.pair === pair && (h.type === "ENTRY_1" || h.type === "ENTRY_2"))
      .sort((a: any, b: any) => b.timestamp - a.timestamp)[0];

    if (!latest) return NextResponse.json({ error: "No entry signal available to confirm" }, { status: 404 });
    if (Date.now() - Number(latest.timestamp) > MAX_CONFIRM_AGE_MS) {
      return NextResponse.json({ error: "This entry signal is older than 7 days; it cannot be confirmed as a current trade" }, { status: 409 });
    }
    if (![latest.entry, latest.stop, latest.tp1, latest.tp2].every((n: any) => Number.isFinite(Number(n)) && Number(n) > 0)) {
      return NextResponse.json({ error: "The selected signal is missing valid entry, stop, or target levels" }, { status: 409 });
    }

    const active = await getActiveSignals();
    const existing = active.find((t: any) => t.pair === pair);
    if (existing) return NextResponse.json({ error: "This symbol already has a confirmed active position", active: existing }, { status: 409 });

    latest.status = "ACTIVE";
    delete latest.exitReason;
    delete latest.exitPrice;
    delete latest.exitTimestamp;
    await setSignalHistory(history);

    const trade: any = {
      ...latest,
      status: "ACTIVE",
      target: latest.tp2,
      context: latest.context || {},
      version: latest.version || 30,
      confirmedManually: true,
      confirmedAt: Date.now(),
    };
    active.push(trade);
    await setActiveSignals(active);

    console.log(`[MANUAL] User confirmed position: ${pair} ${trade.direction} ${trade.type} @ ${trade.entry}`);
    return NextResponse.json({ success: true, pair, activePosition: trade }, {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate" },
    });
  } catch (error) {
    console.error("[MANUAL CONFIRM] Failed", error);
    return NextResponse.json({ error: "Could not confirm manual position" }, { status: 500 });
  }
}
