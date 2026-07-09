// lib/telegram.ts — v29.1 Telegram alerts & commands for CXSwitch
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN) console.warn("[TELEGRAM] TELEGRAM_BOT_TOKEN not set — alerts disabled");
if (!CHAT_ID) console.warn("[TELEGRAM] TELEGRAM_CHAT_ID not set — alerts disabled");

// ─── Types ───

export interface TelegramAlert {
  type: "SIGNAL" | "EXIT" | "ERROR" | "STATUS" | "WARNING";
  pair: string;
  message: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

// ─── Core send ───

export async function sendTelegramMessage(text: string, parseMode: "HTML" | "Markdown" = "HTML"): Promise<boolean> {
  if (!BOT_TOKEN || !CHAT_ID) return false;

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error("[TELEGRAM] Send failed:", data.description);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[TELEGRAM] Network error:", err);
    return false;
  }
}

// ─── Alert formatters ───

export function formatSignalAlert(signal: any): string {
  const dir = signal.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  const mode = signal.entryMode || "ENTRY";
  const conf = signal.confidence || 0;
  const rr = signal.rr || 0;
  const emo = signal.exhaustionWarning ? "⚠️ " : "";

  return `${emo}<b>${dir} ${signal.pair}</b> (${mode})
━━━━━━━━━━━━━━
📍 Entry: <code>${signal.entry}</code>
🛑 Stop:  <code>${signal.stop}</code>
🎯 Target: <code>${signal.target}</code>
📊 R:R: <code>${rr.toFixed(2)}</code> | Conf: <code>${conf.toFixed(0)}%</code>
${signal.exhaustionWarning ? `⚠️ <i>${signal.exhaustionWarning}</i>\n` : ""}
<i>${signal.reason?.split(" | ")[0] || ""}</i>`;
}

export function formatExitAlert(signal: any, exitPrice: number, reason: string): string {
  const dir = signal.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  const pnl = signal.direction === "LONG"
    ? ((exitPrice - signal.entry) / signal.entry) * 100
    : ((signal.entry - exitPrice) / signal.entry) * 100;
  const pnlEmoji = pnl >= 0 ? "✅" : "❌";

  return `<b>${pnlEmoji} EXIT ${signal.pair}</b> ${dir}
━━━━━━━━━━━━━━
📍 Entry: <code>${signal.entry}</code>
💰 Exit:  <code>${exitPrice.toFixed(2)}</code>
📈 PnL:  <code>${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%</code>
📝 Reason: <i>${reason}</i>`;
}

export function formatStatusAlert(signals: any[], prices: Record<string, number>): string {
  if (signals.length === 0) return "📊 <b>CXSwitch v29.1</b>\nNo active signals.";

  const lines = signals.map(s => {
    const price = prices[s.pair] || s.entry;
    const pnl = s.direction === "LONG"
      ? ((price - s.entry) / s.entry) * 100
      : ((s.entry - price) / s.entry) * 100;
    const state = s.tradeState || "OPEN";
    const pnlStr = pnl >= 0 ? `+${pnl.toFixed(2)}%` : `${pnl.toFixed(2)}%`;
    return `• ${s.pair} ${s.direction} | ${state} | ${pnlStr}`;
  });

  return `📊 <b>CXSwitch v29.1 Active Signals</b>
━━━━━━━━━━━━━━
${lines.join("\n")}`;
}

export function formatNoSignalAlert(pair: string, market: any, debugLines: string[]): string {
  const regime = market.regime || {};
  const trend = market.trend || "UNKNOWN";
  const stoch = market.stochK !== undefined ? `Stoch ${market.stochK.toFixed(1)}/${market.stochD?.toFixed(1)}` : "";

  return `⏸️ <b>NO SIGNAL — ${pair}</b>
━━━━━━━━━━━━━━
📈 Trend: <i>${trend}</i>
📊 ADX: <code>${market.adx || "N/A"}</code> | RSI: <code>${market.rsi || "N/A"}</code>
${stoch ? `📉 ${stoch}\n` : ""}
<i>${debugLines.slice(-3).join("\n")}</i>`;
}

// ─── High-level alerts ───

export async function alertSignal(signal: any): Promise<boolean> {
  const text = formatSignalAlert(signal);
  return sendTelegramMessage(text);
}

export async function alertExit(signal: any, exitPrice: number, reason: string): Promise<boolean> {
  const text = formatExitAlert(signal, exitPrice, reason);
  return sendTelegramMessage(text);
}

export async function alertStatus(signals: any[], prices: Record<string, number>): Promise<boolean> {
  const text = formatStatusAlert(signals, prices);
  return sendTelegramMessage(text);
}

export async function alertNoSignal(pair: string, market: any, debugLines: string[]): Promise<boolean> {
  const text = formatNoSignalAlert(pair, market, debugLines);
  return sendTelegramMessage(text);
}

export async function alertError(context: string, error: any): Promise<boolean> {
  const text = `🚨 <b>CXSwitch ERROR</b>
━━━━━━━━━━━━━━
Context: <code>${context}</code>
Error: <pre>${String(error).slice(0, 400)}</pre>`;
  return sendTelegramMessage(text);
}

export async function alertWarning(pair: string, message: string): Promise<boolean> {
  const text = `⚠️ <b>WARNING — ${pair}</b>
━━━━━━━━━━━━━━
${message}`;
  return sendTelegramMessage(text);
}
