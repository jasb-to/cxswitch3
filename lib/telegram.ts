import { sendTelegram } from "@/lib/telegram";

export async function fireAlert(signal: any) {
  if (!signal) return;

  const msg =
    signal.state === "SNIPER"
      ? `🔥 SNIPER ALERT\n${signal.symbol} @ ${signal.price}`
      : signal.state === "EARLY"
      ? `🟣 EARLY ALERT\n${signal.symbol} @ ${signal.price}`
      : null;

  if (!msg) return;

  console.log("[ALERT ENGINE]", msg);

  await sendTelegram(msg);
}
