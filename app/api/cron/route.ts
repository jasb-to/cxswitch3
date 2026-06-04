import { NextResponse } from "next/server";
import { getCandles, getCurrentPrice } from "@/lib/kraken";
import { generateSignal } from "@/lib/strategy";
import { setSignals } from "@/lib/state";
import { sendAlert } from "@/lib/telegram";

export const runtime = "nodejs";

export async function GET() {
  const symbols = ["BTC", "ETH", "SOL"] as const;

  const candles15 = await Promise.all(
    symbols.map(s => getCandles(s, 15))
  );

  const candles1h = await Promise.all(
    symbols.map(s => getCandles(s, 60))
  );

  // FIX: Fetch 4H candles — was missing, causing undefined.length crash
  const candles4h = await Promise.all(
    symbols.map(s => getCandles(s, 240))
  );

  const prices = await Promise.all(
    symbols.map(s => getCurrentPrice(s))
  );

  // FIX: Pass all 4 candle arrays to generateSignal
  const signals = symbols.map((s, i) =>
    generateSignal(s, prices[i], candles15[i], candles1h[i], candles4h[i])
  );

  setSignals(signals);

  console.log("[CRON] FULL SIGNAL SNAPSHOT");

  for (const s of signals) {
    console.log(s);
  }

  for (const s of signals) {
    if (s.state === "WAIT") continue;

    await sendAlert({
      ...s,
      timestamp: s.updatedAt,
    });

    console.log("[ALERT SENT]", {
      symbol: s.symbol,
      state: s.state,
      confidence: s.confidence,
      rr: s.rr,
    });
  }

  return NextResponse.json({ ok: true, signals });
}
