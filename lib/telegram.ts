// lib/telegram.ts — v29.1 Telegram alerts (backward compatible)
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN) console.warn("[TELEGRAM] TELEGRAM_BOT_TOKEN not set");
if (!CHAT_ID) console.warn("[TELEGRAM] TELEGRAM_CHAT_ID not set");

// ─── Core send ───

async function sendMessage(text: string, parseMode: "HTML" | "Markdown" = "HTML"): Promise<boolean> {
  if (!BOT_TOKEN || !CHAT_ID) return false;
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: text.slice(0, 4096),
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json();
    if (!data.ok) { console.error("[TELEGRAM]", data.description); return false; }
    return true;
  } catch (err) {
    console.error("[TELEGRAM] Network error:", err);
    return false;
  }
}

// ─── Backward-compatible alerts (old API surface) ───

export async function sendAlert(signal: any): Promise<boolean> {
  const dir = signal.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  const mode = signal.entryMode || "ENTRY";
  const conf = signal.confidence || 0;
  const rr = signal.rr || 0;
  const emo = signal.exhaustionWarning ? "⚠️ " : "";

  const text = `${emo}<b>${dir} ${signal.pair}</b> (${mode})
━━━━━━━━━━━━━━
📍 Entry: <code>${signal.entry}</code>
🛑 Stop:  <code>${signal.stop}</code>
🎯 Target: <code>${signal.target}</code>
📊 R:R: <code>${rr.toFixed(2)}</code> | Conf: <code>${conf.toFixed(0)}%</code>
${signal.exhaustionWarning ? `⚠️ <i>${signal.exhaustionWarning}</i>
` : ""}
<i>${(signal.reason || "").split(" | ")[0]}</i>`;

  return sendMessage(text);
}

export async function sendExitAlert(signal: any, exitPrice: number, reason: string): Promise<boolean> {
  const dir = signal.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  const pnl = signal.direction === "LONG"
    ? ((exitPrice - signal.entry) / signal.entry) * 100
    : ((signal.entry - exitPrice) / signal.entry) * 100;
  const pnlEmoji = pnl >= 0 ? "✅" : "❌";

  const text = `<b>${pnlEmoji} EXIT ${signal.pair}</b> ${dir}
━━━━━━━━━━━━━━
📍 Entry: <code>${signal.entry}</code>
💰 Exit:  <code>${exitPrice.toFixed(2)}</code>
📈 PnL:  <code>${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%</code>
📝 Reason: <i>${reason}</i>`;

  return sendMessage(text);
}

// ─── New v29 alerts (additional) ───

export async function alertSignal(signal: any): Promise<boolean> {
  return sendAlert(signal);
}

export async function alertExit(signal: any, exitPrice: number, reason: string): Promise<boolean> {
  return sendExitAlert(signal, exitPrice, reason);
}

export async function alertStatus(signals: any[], prices: Record<string, number>): Promise<boolean> {
  if (signals.length === 0) return sendMessage("📊 <b>CXSwitch v29.1</b>
No active signals.");

  const lines = signals.map(s => {
    const price = prices[s.pair] || s.entry;
    const pnl = s.direction === "LONG"
      ? ((price - s.entry) / s.entry) * 100
      : ((s.entry - price) / s.entry) * 100;
    const state = s.tradeState || "OPEN";
    return `• ${s.pair} ${s.direction} | ${state} | ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%`;
  });

  return sendMessage(`📊 <b>CXSwitch v29.1 Active Signals</b>
━━━━━━━━━━━━━━
${lines.join("
")}`);
}

export async function alertNoSignal(pair: string, market: any, debugLines: string[]): Promise<boolean> {
  const trend = market?.trend || "UNKNOWN";
  const stoch = market?.stochK !== undefined ? `Stoch ${market.stochK.toFixed(1)}/${market.stochD?.toFixed(1)}` : "";

  const text = `⏸️ <b>NO SIGNAL — ${pair}</b>
━━━━━━━━━━━━━━
📈 Trend: <i>${trend}</i>
📊 ADX: <code>${market?.adx || "N/A"}</code> | RSI: <code>${market?.rsi || "N/A"}</code>
${stoch ? `📉 ${stoch}
` : ""}
<i>${(debugLines || []).slice(-3).join("
")}</i>`;

  return sendMessage(text);
}

export async function alertError(context: string, error: any): Promise<boolean> {
  const text = `🚨 <b>CXSwitch ERROR</b>
━━━━━━━━━━━━━━
Context: <code>${context}</code>
Error: <pre>${String(error).slice(0, 400)}</pre>`;
  return sendMessage(text);
}
