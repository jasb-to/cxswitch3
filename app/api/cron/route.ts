import { getLivePrices } from "@/lib/prices";
import { sendTelegram } from "@/lib/telegram";

export const runtime = "nodejs";

let lastState: Record<string, string> = {};
let lastAlertTime: Record<string, number> = {};

function computeState(price: number) {
  const seed = price % 1000;

  const compression = (seed % 100) / 100;
  const momentum = (seed % 37) / 37;

  if (compression < 0.35 && momentum < 0.5) return "EARLY";
  if (compression > 0.75 && momentum > 0.6) return "SNIPER";
  return "WAIT";
}

export async function GET() {
  const prices = await getLivePrices();
  const now = Date.now();

  for (const [symbol, price] of Object.entries(prices)) {
    const state = computeState(price);

    const prev = lastState[symbol];
    const last = lastAlertTime[symbol] || 0;

    const cooldown = now - last < 30000; // 30s cooldown

    lastState[symbol] = state;

    if (cooldown) continue;
    if (state === prev) continue;

    lastAlertTime[symbol] = now;

    const msg =
      state === "SNIPER"
        ? `🔥 SNIPER ${symbol} @ ${price}`
        : state === "EARLY"
        ? `🟣 EARLY ${symbol} @ ${price}`
        : null;

    if (msg) await sendTelegram(msg);
  }

  return Response.json({ ok: true });
}
