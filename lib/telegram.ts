const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
if (!BOT_TOKEN) console.warn("[TELEGRAM] TELEGRAM_BOT_TOKEN not set");
if (!CHAT_ID) console.warn("[TELEGRAM] TELEGRAM_CHAT_ID not set");

async function sendMessage(text: string, parseMode: "HTML" | "Markdown" = "HTML"): Promise<boolean> {
  if (!BOT_TOKEN || !CHAT_ID) return false;
  const url = "https://api.telegram.org/bot" + BOT_TOKEN + "/sendMessage";
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: CHAT_ID, text: text.slice(0, 4096), parse_mode: parseMode, disable_web_page_preview: true }) });
    const data = await res.json();
    if (!data.ok) { console.error("[TELEGRAM]", data.description); return false; }
    return true;
  } catch (err) { console.error("[TELEGRAM] Network error:", err); return false; }
}

function sf(v: any, d: number): string { const n = Number(v); return isFinite(n) ? n.toFixed(d) : "0"; }

export async function sendAlert(signal: any): Promise<boolean> {
  if (signal.entryTier === "NO_TRADE" || signal.scale === null) { console.log("[TELEGRAM SKIP] " + signal.pair + " - no actionable signal"); return false; }
  const entry = sf(signal.entry, 2), stop = sf(signal.stop, 2), target = sf(signal.target, 2);
  const slPct = sf(Math.abs((signal.stop - signal.entry) / signal.entry) * 100, 1);
  const tpPct = sf(Math.abs((signal.target - signal.entry) / signal.entry) * 100, 1);
  const isEarly = signal.entryTier === "EARLY_ENTRY";
  const label = isEarly ? "EARLY ENTRY" : "CONFIRMED ENTRY";
  const size = isEarly ? "33% starter" : "FULL SIZE";
  const text = label + " - " + signal.pair + " | Direction: " + signal.direction + " | Confidence: " + sf(signal.confidence, 0) + "% | Position: " + size + " | Entry: " + entry + " | Stop: " + stop + " | Target: " + target + " | RR " + sf(signal.rr || 0, 2) + " | SL " + slPct + "% | TP " + tpPct + "% | id=" + signal.id;
  return sendMessage(text);
}

export async function sendExitAlert(signal: any, exitPrice: number, reason: string): Promise<boolean> {
  const rawPnl = signal.direction === "LONG" ? ((exitPrice - signal.entry) / signal.entry) * 100 : ((signal.entry - exitPrice) / signal.entry) * 100;
  const pnl = isFinite(rawPnl) ? rawPnl : 0;
  const sign = pnl >= 0 ? "+" : "";
  const text = "EXIT " + signal.pair + " " + signal.direction + " - " + sign + sf(pnl, 2) + "% | Entry: " + sf(signal.entry, 2) + " | Exit: " + sf(exitPrice, 2) + " | Reason: " + reason + " | id=" + signal.id;
  return sendMessage(text);
}

export async function alertStatus(signals: any[], prices: Record<string, number>): Promise<boolean> {
  if (signals.length === 0) return sendMessage("CXSwitch v33 - No active signals.");
  const lines = signals.map(s => {
    const price = prices[s.pair] || s.entry;
    const rawPnl = s.direction === "LONG" ? ((price - s.entry) / s.entry) * 100 : ((s.entry - price) / s.entry) * 100;
    const pnl = isFinite(rawPnl) ? rawPnl : 0;
    const sign = pnl >= 0 ? "+" : "";
    return s.pair + " " + s.direction + " | " + (s.tradeState || "OPEN") + " | " + sign + sf(pnl, 2) + "%";
  });
  return sendMessage("CXSwitch v33 Active Signals | " + lines.join(" | "));
}

export async function alertError(context: string, error: any): Promise<boolean> {
  return sendMessage("CXSwitch ERROR | Context: " + context + " | " + String(error).slice(0, 400));
}
