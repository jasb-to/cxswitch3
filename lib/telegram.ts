// lib/telegram.ts — v28 "Clean alert dispatch"
// ============================================================

interface AlertPayload {
  symbol?: string;
  pair?: string;
  direction?: "LONG" | "SHORT";
  bias?: "LONG" | "SHORT";
  stage?: string;
  state?: string;
  type?: string;
  confidence: number;
  entry?: number;
  price?: number;
  stop?: number;
  stopLoss?: number;
  target?: number;
  takeProfit?: number;
  rr?: number;
  reason?: string;
  explanation?: string;
  id?: string;
}

function resolveAlert(payload: AlertPayload) {
  const pair = payload.symbol || payload.pair || "UNKNOWN";
  const direction = payload.bias || payload.direction || "SHORT";
  const stage = payload.state || payload.stage || payload.type || "UNKNOWN";
  const price = payload.price ?? payload.entry ?? 0;
  const stop = payload.stopLoss ?? payload.stop ?? 0;
  const target = payload.takeProfit ?? payload.target ?? 0;
  const reason = payload.reason || payload.explanation || "";
  const id = payload.id || "no-id";
  return { pair, direction, stage, price, stop, target, reason, id, confidence: payload.confidence, rr: payload.rr };
}

function isActionableStage(stage: string): boolean {
  // PATCH: Added "ENTRY" for v28 strategy
  const actionable = ["ACCUMULATE", "BREAKOUT", "CONFIRMED", "EXPANSION", "READY", "ENTRY"];
  return actionable.includes(stage.toUpperCase());
}

async function sendTelegramMessage(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log("[TELEGRAM DISABLED]", text.slice(0, 100));
    return false;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" });

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const data = await res.json();
      if (data.ok) return true;
      console.error(`[TELEGRAM ERROR] attempt ${attempt}:`, data);
      if (attempt === 1) await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.error(`[TELEGRAM SEND FAILED] attempt ${attempt}:`, err);
      if (attempt === 1) await new Promise(r => setTimeout(r, 1000));
    }
  }
  return false;
}

export async function sendAlert(payload: AlertPayload) {
  const alert = resolveAlert(payload);

  if (!isActionableStage(alert.stage)) {
    console.log(`[TELEGRAM SKIP: NON-ACTIONABLE] ${alert.pair} stage=${alert.stage} id=${alert.id}`);
    return;
  }

  const minConfidence = 55;
  if (alert.confidence < minConfidence) {
    console.log(`[TELEGRAM SKIP: LOW CONFIDENCE] ${alert.pair} ${alert.confidence}% (need ${minConfidence}%) id=${alert.id}`);
    return;
  }

  const dirEmoji = alert.direction === "LONG" ? "🟢" : "🔴";
  const confColor = alert.confidence >= 85 ? "🟢" : alert.confidence >= 70 ? "🟡" : "🟠";

  const text = `${dirEmoji} <b>${alert.pair}</b> ${alert.direction} ${alert.stage} — ${confColor} ${alert.confidence}%
Entry: ${alert.price} | Stop: ${alert.stop} | Target: ${alert.target}
RR ${alert.rr ?? "N/A"} | ${alert.reason}
<code>id=${alert.id}</code>`;

  const sent = await sendTelegramMessage(text);
  if (sent) {
    console.log(`[TELEGRAM SENT] ${alert.pair} ${alert.direction} ${alert.confidence}% id=${alert.id}`);
  } else {
    console.error(`[TELEGRAM FAILED] ${alert.pair} id=${alert.id}`);
  }
}

export async function sendExitAlert(payload: {
  pair: string;
  direction: "LONG" | "SHORT";
  exitPrice: number;
  reason: string;
  pnl?: number;
  id?: string;
}) {
  const { pair, direction, exitPrice, reason, pnl, id = "no-id" } = payload;
  const dirEmoji = direction === "LONG" ? "🟢" : "🔴";
  const pnlEmoji = pnl && pnl > 0 ? "✅" : pnl && pnl < 0 ? "❌" : "⚪";
  const pnlText = pnl !== undefined ? ` | PnL: ${pnlEmoji} ${pnl.toFixed(2)}%` : "";

  const text = `${dirEmoji} <b>${pair}</b> ${direction} EXIT — ${reason}${pnlText}
Exit Price: ${exitPrice}
<code>id=${id}</code>`;

  const sent = await sendTelegramMessage(text);
  if (sent) {
    console.log(`[TELEGRAM EXIT] ${pair} ${direction} ${reason} id=${id}`);
  }
}

export async function sendUIAlert(alert: {
  pair: string;
  type: string;
  message: string;
  stochK?: number;
  stochD?: number;
}) {
  const { pair, type, message, stochK, stochD } = alert;
  const isWarning = type.includes("OVERSOLD") || type.includes("OVERBOUGHT");
  const emoji = isWarning ? "⚠️" : "ℹ️";

  let text = `${emoji} <b>${pair}</b> — ${type}
${message}`;
  if (stochK !== undefined && stochD !== undefined) {
    text += `
Stoch K=${stochK.toFixed(1)} D=${stochD.toFixed(1)}`;
  }
  text += `
<i>UI warning only — not a trading signal</i>`;

  const sent = await sendTelegramMessage(text);
  if (sent) {
    console.log(`[TELEGRAM UI] ${pair} ${type}`);
  }
}
