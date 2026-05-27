import { evaluateSignal } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const signals = await Promise.all([
      evaluateSignal("BTC"),
      evaluateSignal("ETH"),
      evaluateSignal("SOL"),
    ]);
    
    return Response.json({ signals, timestamp: Date.now() });
  } catch (error) {
    console.error("[API/SIGNALS] Error:", error);
    return Response.json({ error: "Failed to evaluate signals" }, { status: 500 });
  }
}
