import { sendTelegram } from "@/lib/telegram";

let lastState: Record<string, string> = {};

export async function processAlerts(signals: any[]) {
  if (!Array.isArray(signals)) return;

  for (const s of signals) {
    const previous = lastState[s.symbol];

    if (previous !== s.state) {
      lastState[s.symbol] = s.state;

      console.log(
        `[ALERT ENGINE] ${s.symbol}: ${previous} -> ${s.state}`
      );

      if (s.state === "SNIPER") {
        await sendTelegram(
          [
            "🔥 CX SWITCH SNIPER",
            "",
            `${s.symbol}`,
            `Price: ${s.price}`,
            `Bias: ${s.bias}`,
            `Confidence: ${s.confidence}%`,
            `TP: ${s.takeProfit ?? "-"}`,
            `SL: ${s.stopLoss ?? "-"}`,
          ].join("\n")
        );
      }

      if (s.state === "EARLY") {
        await sendTelegram(
          [
            "🟣 CX SWITCH EARLY",
            "",
            `${s.symbol}`,
            `Price: ${s.price}`,
            "Compression detected",
          ].join("\n")
        );
      }
    }
  }
}
