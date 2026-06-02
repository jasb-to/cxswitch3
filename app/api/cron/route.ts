import { getLivePrices } from "@/lib/prices";
import { sendTelegram } from "@/lib/telegram";

export const runtime = "nodejs";

let lastState: Record<string, string> = {};

function detectState(price: number) {
  const compression = (price % 100) / 100;
  const momentum = (price % 17) / 17;

  if (compression < 0.35 && momentum < 0.5) return "EARLY";
  if (compression > 0.75 && momentum > 0.6) return "SNIPER";
  return "WAIT";
}

export async function GET() {
  const prices = await getLivePrices();

  for (const [symbol, price] of Object.entries(prices)) {
    const state = detectState(price);

    const prev = lastState[symbol];

    // only trigger on CHANGE
    if (prev === state) continue;

    lastState[symbol] = state;

    if (state === "EARLY") {
      await sendTelegram(`🟣 EARLY ENTRY ${symbol} @ ${price}`);
    }

    if (state === "SNIPER") {
      await sendTelegram(`🔥 SNIPER BREAKOUT ${symbol} @ ${price}`);
    }
  }

  return Response.json({ ok: true });
}
