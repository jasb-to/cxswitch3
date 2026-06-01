import { generateAndStoreSignals } from "@/lib/signalEngine";

export const runtime = "nodejs";

const SYMBOLS = ["BTC", "ETH", "SOL"];

export async function GET() {
  try {
    const prices = {
      BTC: 71000,
      ETH: 2000,
      SOL: 80,
    };

    const safeSymbols = SYMBOLS ?? [];
    const safePrices = safeSymbols.map((s) => prices[s as keyof typeof prices] ?? 0);

    if (!Array.isArray(safeSymbols) || safeSymbols.length === 0) {
      throw new Error("No symbols defined");
    }

    const signals = await generateAndStoreSignals(safeSymbols, safePrices);

    console.log(`[CRON] Generated ${signals.length} signals`);

    return Response.json({
      ok: true,
      signalsCount: signals.length,
    });
  } catch (err) {
    console.error("[CRON ERROR]", err);

    return Response.json(
      { ok: false, error: "CRON failed" },
      { status: 500 }
    );
  }
}
