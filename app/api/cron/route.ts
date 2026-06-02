import { sendTelegram } from "@/lib/telegram";

const symbols = ["BTC", "ETH", "SOL"];

const prices = {
  BTC: 70000,
  ETH: 2000,
  SOL: 80,
};

let lastState: Record<string, string> = {};

function generateSignal(symbol: string, price: number) {
  const rand = Math.random();

  return {
    symbol,
    price,
    state: rand > 0.7 ? "SNIPER" : rand > 0.4 ? "EARLY" : "WAIT",
  };
}

export async function GET() {
  for (const s of symbols) {
    const signal = generateSignal(s, prices[s]);

    if (lastState[s] !== signal.state) {
      lastState[s] = signal.state;

      if (signal.state === "SNIPER") {
        await sendTelegram(`🔥 SNIPER ${s} @ ${prices[s]}`);
      }

      if (signal.state === "EARLY") {
        await sendTelegram(`🟣 EARLY ${s} @ ${prices[s]}`);
      }
    }
  }

  return Response.json({ ok: true });
}
