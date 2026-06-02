import { getLivePrices } from "@/lib/prices";
import { sendTelegram } from "@/lib/telegram";

export const runtime = "nodejs";

let lastState: Record<string, string> = {};
let lastAlertTime: Record<string, number> = {};

function getState(price: number) {
  const compression = (price % 100) / 100;
  const momentum = (price % 17) / 17;

  if (compression < 0.35 && momentum < 0.5) return "EARLY";
  if (compression > 0.75 && momentum > 0.6) return "SNIPER";
  return "WAIT";
}

export async function GET() {
  const prices = await getLivePrices();
  const now = Date.now();

  for (const [symbol, price] of Object.entries(prices)) {
    const state = getState(price);

    const prev = lastState[symbol];
    const last = lastAlertTime[symbol] || 0;

    const cooldown = now - last < 15000;

    lastState[symbol] = state;

    if (cooldown) continue;

    if (state === prev) continue;

    lastAlertTime[symbol] = now;

    if (state === "EARLY") {
      await sendTelegram(`🟣 EARLY ENTRY ${symbol} @ ${price}`);
    }

    if (state === "SNIPER") {
      await sendTelegram(`🔥 SNIPER BREAKOUT ${symbol} @ ${price}`);
    }
  }

  return Response.json({ ok: true });
}
