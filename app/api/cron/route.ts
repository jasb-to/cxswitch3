import { sendTelegram } from "@/lib/telegram";

export const runtime = "nodejs";

const prices = {
  BTC: 70000,
  ETH: 2000,
  SOL: 80,
};

let lastState: Record<string, string> = {};

function getState(symbol: string, price: number) {
  const seed = price % 100;

  const compression = (seed % 30) / 30;
  const momentum = (seed % 10) / 10;

  if (compression < 0.35 && momentum < 0.5) return "EARLY";
  if (compression > 0.7 && momentum > 0.6) return "SNIPER";
  return "WAIT";
}

export async function GET() {
  for (const symbol of Object.keys(prices)) {
    const state = getState(symbol, prices[symbol]);

    const prev = lastState[symbol];

    // only alert on meaningful transitions
    if (prev === state) continue;

    lastState[symbol] = state;

    if (state === "EARLY") {
      await sendTelegram(`🟣 EARLY ENTRY ${symbol} @ ${prices[symbol]}`);
    }

    if (state === "SNIPER") {
      await sendTelegram(`🔥 SNIPER BREAKOUT ${symbol} @ ${prices[symbol]}`);
    }
  }

  return Response.json({ ok: true });
}
