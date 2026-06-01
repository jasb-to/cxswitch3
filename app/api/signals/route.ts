import { getLivePrices } from "@/lib/prices";
import { generateSignal } from "@/lib/signalEngine";

export const runtime = "nodejs";

export async function GET() {
  try {
    const prices = await getLivePrices();

    const symbols = ["BTC", "ETH", "SOL"];

    const signals = symbols.map((symbol) => {
      const price = prices[symbol as keyof typeof prices];

      const signal = generateSignal(symbol, price);

      return {
        ...signal,
        price,
      };
    });

    return Response.json({
      signals,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);

    return Response.json(
      { signals: [] },
      { status: 500 }
    );
  }
}
