import { sendTelegram } from "./telegram";

let lastState: Record<string, string> = {};

export async function processAlerts(signals: any[]) {
  for (const s of signals) {
    if (!s?.symbol) continue;

    const prev = lastState[s.symbol];

    const newSniper =
      s.state === "SNIPER" && prev !== "SNIPER";

    const newEarly =
      s.state === "EARLY" && prev !== "EARLY";

    if (newSniper) {
      await sendTelegram(
        `🔥 <b>SNIPER ALERT</b>\n${s.symbol} @ ${s.price}`
      );
    }

    if (newEarly) {
      await sendTelegram(
        `🟣 <b>EARLY ALERT</b>\n${s.symbol} @ ${s.price}`
      );
    }

    lastState[s.symbol] = s.state;
  }
}
