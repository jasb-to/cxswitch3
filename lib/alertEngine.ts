let lastAlertState: Record<string, string> = {};

import { sendTelegram } from "./telegram";

export async function processAlerts(signals: any[]) {
  for (const s of signals) {
    if (!s?.symbol) continue;

    const prev = lastAlertState[s.symbol];

    const isNewSniper =
      s.state === "SNIPER" && prev !== "SNIPER";

    const isNewEarly =
      s.state === "EARLY" && prev !== "EARLY";

    if (isNewSniper) {
      await sendTelegram(
        `🔥 <b>SNIPER ALERT</b>\n${s.symbol} @ ${s.price}\nSL: ${s.stopLoss}\nTP: ${s.takeProfit}`
      );
    }

    if (isNewEarly) {
      await sendTelegram(
        `🟣 <b>EARLY ALERT</b>\n${s.symbol} @ ${s.price}\nCompression forming`
      );
    }

    lastAlertState[s.symbol] = s.state;
  }
}
