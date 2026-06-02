import { sendTelegram } from "@/lib/telegram";

let lastState: Record<string, string> = {};

export async function processAlerts(signals: any[]) {
  for (const s of signals) {
    if (lastState[s.symbol] === s.state) continue;

    lastState[s.symbol] = s.state;

    if (s.state === "SNIPER") {
      await sendTelegram(
        `🔥 SNIPER\n${s.symbol} @ ${s.price}\nTP: ${s.takeProfit}\nSL: ${s.stopLoss}`
      );
    }

    if (s.state === "EARLY") {
      await sendTelegram(
        `🟣 EARLY\n${s.symbol} @ ${s.price}\nCompression detected`
      );
    }
  }
}
