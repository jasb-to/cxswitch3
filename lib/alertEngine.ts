import { sendTelegram } from "@/lib/telegram";

let lastState: Record<string, string> = {};

export async function processAlerts(signals: any[]) {
  if (!Array.isArray(signals)) return;

  for (const s of signals) {
    if (!s?.symbol) continue;

    const prev = lastState[s.symbol];

    const isNewSniper =
      s.state === "SNIPER" && prev !== "SNIPER";

    const isNewEarly =
      s.state === "EARLY" && prev !== "EARLY";

    if (isNewSniper) {
      console.log("[ALERT] SNIPER", s.symbol);

      await sendTelegram(
        `🔥 SNIPER ALERT\n${s.symbol} @ ${s.price}\nTP: ${s.takeProfit}\nSL: ${s.stopLoss}`
      );
    }

    if (isNewEarly) {
      console.log("[ALERT] EARLY", s.symbol);

      await sendTelegram(
        `🟣 EARLY ALERT\n${s.symbol} @ ${s.price}`
      );
    }

    lastState[s.symbol] = s.state;
  }
}
