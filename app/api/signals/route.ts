import { getCachedSignals, evaluateSignal, setCachedSignals } from "@/lib/engine";

export async function GET() {
  // Try cached signals first (set by /api/cron)
  const cached = getCachedSignals();
  if (cached.length > 0) {
    return Response.json({ signals: cached, timestamp: Date.now(), source: "cache" });
  }

  // Fallback: compute fresh if no cache (first load or cache expired)
  try {
    const [btc, eth, sol] = await Promise.all([
      evaluateSignal("BTC"),
      evaluateSignal("ETH"),
      evaluateSignal("SOL"),
    ]);
    const signals = [btc, eth, sol];
    setCachedSignals(signals);
    return Response.json({ signals, timestamp: Date.now(), source: "fresh" });
  } catch (err) {
    console.error("[SIGNALS] Failed:", err);
    return Response.json({ error: "Failed to evaluate signals", signals: [] }, { status: 500 });
  }
}
