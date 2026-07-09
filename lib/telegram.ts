// lib/telegram.ts — v29.1 Telegram alerts (FIXED)
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN) console.warn("[TELEGRAM] TELEGRAM_BOT_TOKEN not set");
if (!CHAT_ID) console.warn("[TELEGRAM] TELEGRAM_CHAT_ID not set");

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

function safeFixed(v: any, digits: number): string {
  const n = Number(v);
  return isFinite(n) ? n.toFixed(digits) : "0";
}

export async function sendAlert(signal: any): Promise<boolean> {
  const dirEmoji = signal.direction === "LONG" ? "🟢" : "🔴";
  const confEmoji = signal.confidence >= 70 ? "🟢" : signal.confidence >= 50 ? "🟡" : "🔴";
  const mode = signal.entryMode || "ENTRY";
  const conf = signal.confidence || 0;
  const rr = signal.rr || 0;
  const entry = safeFixed(signal.entry, 2);
  const stop = safeFixed(signal.stop, 2);
  const target = safeFixed(signal.target, 2);
  const slPct = safeFixed(Math.abs((signal.stop - signal.entry) / signal.entry) * 100, 1);
  const tpPct = safeFixed(Math.abs((signal.target - signal.entry) / signal.entry) * 100, 1);

  // Build regime context line
  const regimeParts: string[] = [];
  if (signal.regimeDirection) regimeParts.push(`${signal.regimeDirection}`);
  if (signal.entryMode) regimeParts.push(`${signal.entryMode}`);

  // Build reason tags
  const reasonTags = (signal.reason || "").split(" | ").filter((r: string) => r.length > 0);
  const tagLine = reasonTags.slice(0, 6).join(", ");

  const text = 
    `${dirEmoji} ${signal.pair} ${signal.direction} ${mode} — ${confEmoji} ${safeFixed(conf, 0)}%
` +
    `Entry: ${entry} | Stop: ${stop} | Target: ${target}
` +
    `RR ${safeFixed(rr, 2)} | ${regimeParts.join(" ")} | ${tagLine} | RR ${safeFixed(rr, 2)} | SL ${slPct}% TP ${tpPct}%
` +
    `id=${signal.id}`;

  return sendMessage(text);
}

export async function sendExitAlert(signal: any, exitPrice: number, reason: string): Promise<boolean> {
  const dirEmoji = signal.direction === "LONG" ? "🟢" : "🔴";
  const rawPnl = signal.direction === "LONG"
    ? ((exitPrice - signal.entry) / signal.entry) * 100
    : ((signal.entry - exitPrice) / signal.entry) * 100;
  const pnl = isFinite(rawPnl) ? rawPnl : 0;
  const pnlEmoji = pnl >= 0 ? "✅" : "❌";
  const pnlSign = pnl >= 0 ? "+" : "";

  const text = 
    `${pnlEmoji} ${signal.pair} ${signal.direction} EXIT — ${pnlSign}${safeFixed(pnl, 2)}%
` +
    `Entry: ${safeFixed(signal.entry, 2)} | Exit: ${safeFixed(exitPrice, 2)}
` +
    `Reason: ${reason}
` +
    `id=${signal.id}`;

  return sendMessage(text);
}

export async function alertSignal(signal: any): Promise<boolean> {
  return sendAlert(signal);
}

export async function alertExit(signal: any, exitPrice: number, reason: string): Promise<boolean> {
  return sendExitAlert(signal, exitPrice, reason);
}

export async function alertStatus(signals: any[], prices: Record<string, number>): Promise<boolean> {
  if (signals.length === 0) {
    return sendMessage("📊 CXSwitch v29.1\nNo active signals.");
  }

  const lines = signals.map(s => {
    const price = prices[s.pair] || s.entry;
    const rawPnl = s.direction === "LONG"
      ? ((price - s.entry) / s.entry) * 100
      : ((s.entry - price) / s.entry) * 100;
    const pnl = isFinite(rawPnl) ? rawPnl : 0;
    const state = s.tradeState || "OPEN";
    const pnlSign = pnl >= 0 ? "+" : "";
    return `• ${s.pair} ${s.direction} | ${state} | ${pnlSign}${safeFixed(pnl, 2)}%`;
  });

  return sendMessage("📊 CXSwitch v29.1 Active Signals\n" + lines.join("\n"));
}

export async function alertNoSignal(pair: string, market: any, debugLines: string[]): Promise<boolean> {
  const trend = market?.trend || "UNKNOWN";
  const adx = market?.adx !== undefined ? safeFixed(market.adx, 1) : "N/A";
  const rsi = market?.rsi !== undefined ? safeFixed(market.rsi, 1) : "N/A";
  const stochK = market?.stochK !== undefined ? safeFixed(market.stochK, 1) : null;
  const stochD = market?.stochD !== undefined ? safeFixed(market.stochD, 1) : null;
  const stochLine = stochK !== null && stochD !== null ? `Stoch ${stochK}/${stochD}` : "";

  const text = 
    `⏸️ NO SIGNAL — ${pair}
` +
    `Trend: ${trend} | ADX: ${adx} | RSI: ${rsi}
` +
    (stochLine ? `${stochLine}\n` : "") +
    (debugLines || []).slice(-3).join("\n");

  return sendMessage(text);
}

export async function alertError(context: string, error: any): Promise<boolean> {
  const text = 
    `🚨 CXSwitch ERROR\n` +
    `Context: ${context}\n` +
    `${String(error).slice(0, 400)}`;
  return sendMessage(text);
}
