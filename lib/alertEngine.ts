import { sendTelegram } from "@/lib/telegram";

let lastState: Record<string, string> = {};

export async function processAlerts(signals: any[]) {
  for (const s of signals) {
    if (!s?.symbol) continue;

    const prev = lastState[s.symbol];

    const isNewSniper =
      s.state === "SNIPER" && prev !== "SNIPER";

    const isNewEarly =
      s.state === "EARLY" && prev !== "EARLY";

    if (isNewSniper) {
      await sendTelegram(
        `🔥 SNIPER ALERT\n${s.symbol} @ ${s.price}`
      );
    }

    if (isNewEarly) {
      await sendTelegram(
        `🟣 EARLY ALERT\n${s.symbol} @ ${s.price}`
      );
    }

    lastState[s.symbol] = s.state;
  }
}
