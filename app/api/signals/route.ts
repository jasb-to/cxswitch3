import { evaluateSignal } from "@/lib/engine";

export async function GET() {
  try {
    const [btc, eth, sol] = await Promise.all([
      evaluateSignal("BTC"),
      evaluateSignal("ETH"),
      evaluateSignal("SOL"),
    ]);

    return Response.json({ 
      signals: [btc, eth, sol], 
      timestamp: Date.now() 
    });
  } catch (err) {
    console.error("[SIGNALS] Failed:", err);
    return Response.json({ 
      error: "Failed to evaluate signals", 
      signals: [] 
    }, { status: 500 });
  }
}
