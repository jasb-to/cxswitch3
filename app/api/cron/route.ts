import { getLivePrices } from "@/lib/prices";
import { generateSignal } from "@/lib/signalEngine";
import { setSignals } from "@/lib/state";

export const runtime = "nodejs";

const symbols = ["BTC", "ETH", "SOL"] as const;

export async function GET() {
  const prices = await getLivePrices();

  const signals = symbols.map((symbol) =>
    generateSignal(symbol, prices[symbol])
  );

  setSignals(signals);

  return Response.json({
    ok: true,
    updatedAt: new Date().toISOString(),
    signals,
  });
}
