import { sendTelegram } from "@/lib/telegram";

export const runtime = "nodejs";

const symbols = ["BTC", "ETH", "SOL"];

const prices: Record<string, number> = {
  BTC: 70000,
  ETH: 2000,
  SOL: 80,
};

// 🔒 persistent state in-memory (NO DB)
let lastState: Record<string, string> = {};
let lastAlertTime: Record<string, number> = {};

function generateSignal(price: number) {
  const r = Math.random();

  if (r > 0.78) return "SNIPER";
  if (r > 0.45) return "EARLY";
  return "WAIT";
}

export async function GET() {
  const now = Date.now();

  for (const symbol of symbols) {
    const state = generateSignal(prices[symbol]);

    const previous = lastState[symbol];

    // update UI state always
    lastState[symbol] = state;

    // 🔒 prevent spam (15 sec cooldown)
    const last = lastAlertTime[symbol] || 0;
    const cooldown = now - last < 15000;

    if (cooldown) continue;

    if (state === "SNIPER" && previous !== "SNIPER") {
      lastAlertTime[symbol] = now;

      await sendTelegram(`🔥 SNIPER ${symbol} @ ${prices[symbol]}`);
    }

    if (state === "EARLY" && previous !== "EARLY") {
      lastAlertTime[symbol] = now;

      await sendTelegram(`🟣 EARLY ${symbol} @ ${prices[symbol]}`);
    }
  }

  return Response.json({ ok: true });
}
