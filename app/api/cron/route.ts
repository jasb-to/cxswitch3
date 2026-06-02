import { sendTelegram } from "@/lib/telegram";

const symbols = ["BTC", "ETH", "SOL"];

const prices = {
  BTC: 70000,
  ETH: 2000,
  SOL: 80,
};

let lastState: Record<string, string> = {};

function signal(price: number) {
  const r = Math.random();

  return {
    state: r > 0.75 ? "SNIPER" : r > 0.45 ? "EARLY" : "WAIT",
  };
}

export async function GET() {
  for (const s of symbols) {
    const sig = signal(prices[s]);

    if (lastState[s] !== sig.state) {
      lastState[s] = sig.state;

      if (sig.state === "SNIPER") {
        await sendTelegram(`🔥 SNIPER ${s} @ ${prices[s]}`);
      }

      if (sig.state === "EARLY") {
        await sendTelegram(`🟣 EARLY ${s} @ ${prices[s]}`);
      }
    }
  }

  return Response.json({ ok: true });
}
