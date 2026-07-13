const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN) console.warn("[TELEGRAM] TELEGRAM_BOT_TOKEN not set");
if (!CHAT_ID) console.warn("[TELEGRAM] TELEGRAM_CHAT_ID not set");

async function sendMessage(text: string, parseMode: "HTML" | "Markdown" = "HTML"): Promise<boolean> {
  if (!BOT_TOKEN || !CHAT_ID) return false;
  const url = "https://api.telegram.org/bot" + BOT_TOKEN + "/sendMessage";
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
    if (!data.ok) {
      console.error("[TELEGRAM]", data.description);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[TELEGRAM] Network error:", err);
    return false;
  }
}

function sf(v: any, d: number): string {
  const n = Number(v);
  return isFinite(n) ? n.toFixed(d) : "0";
}

// ============================================================
// v37 TELEGRAM ALERTS — Trend-Following Format
// ============================================================

function getDirectionEmoji(direction: string): string {
  return direction?.toUpperCase() === "LONG" ? "🟢" : "🔴";
}

function getEntryLabel(entryType: string, entryTier: string): string {
  const type = entryType?.toUpperCase() || "";
  const tier = entryTier?.toUpperCase() || "";

  if (type === "RETEST" || tier === "RETEST_ENTRY") return "RETEST ENTRY";
  if (type === "BREAKOUT" || tier === "CONFIRMED_ENTRY") return "CONFIRMED ENTRY";
  if (type === "EARLY" || tier === "EARLY_ENTRY") return "EARLY ENTRY";
  return "ENTRY";
}

function getPositionSize(entryType: string, entryTier: string, scale: string): string {
  const type = entryType?.toUpperCase() || "";
  const tier = entryTier?.toUpperCase() || "";
  const sc = scale?.toUpperCase() || "";

  if (type === "RETEST" || sc === "ENTRY_1") return "FULL SIZE";
  if (type === "BREAKOUT" || sc === "ENTRY_2") return "FULL SIZE";
  if (type === "EARLY") return "50% STARTER";
  if (sc === "ADD") return "ADD POSITION";
  return "FULL SIZE";
}

export async function sendAlert(signal: any): Promise<boolean> {
  if (!signal || !signal.pair) {
    console.log("[TELEGRAM SKIP] Invalid signal object");
    return false;
  }

  // Skip non-actionable signals
  const entryTier = signal.entryTier || "";
  const scale = signal.scale || "";
  if (entryTier === "NO_TRADE" || scale === null) {
    console.log("[TELEGRAM SKIP] " + signal.pair + " - no actionable signal");
    return false;
  }

  const direction = signal.direction || "LONG";
  const pair = signal.pair;
  const confidence = signal.confidence || 0;
  const entry = sf(signal.entry, 2);
  const stop = sf(signal.stop, 2);
  const target = sf(signal.target, 2);
  const rr = sf(signal.rr || 0, 2);
  const slPct = sf(Math.abs((signal.stop - signal.entry) / signal.entry) * 100, 1);
  const tpPct = sf(Math.abs((signal.target - signal.entry) / signal.entry) * 100, 1);

  const emoji = getDirectionEmoji(direction);
  const label = getEntryLabel(signal.entryType, signal.entryTier);
  const size = getPositionSize(signal.entryType, signal.entryTier, signal.scale);

  const text = emoji + " " + label + " — " + pair + "

" +
    "Direction: " + direction + "
" +
    "Confidence: " + sf(confidence, 0) + "%

" +
    "Position:
" + size + "

" +
    "Entry: " + entry + " | Stop: " + stop + " | Target: " + target + "
" +
    "RR " + rr + " | SL " + slPct + "% | TP " + tpPct + "%
" +
    "id=" + signal.id;

  return sendMessage(text);
}

export async function sendExitAlert(signal: any, exitPrice: number, reason: string): Promise<boolean> {
  if (!signal || !signal.pair) {
    console.log("[TELEGRAM SKIP] Invalid signal for exit");
    return false;
  }

  const rawPnl = signal.direction === "LONG"
    ? ((exitPrice - signal.entry) / signal.entry) * 100
    : ((signal.entry - exitPrice) / signal.entry) * 100;
  const pnl = isFinite(rawPnl) ? rawPnl : 0;
  const sign = pnl >= 0 ? "+" : "";
  const emoji = pnl >= 0 ? "🟢" : "🔴";
  const entryType = signal.entryType || signal.entryMode || "ENTRY";

  const text = emoji + " EXIT — " + signal.pair + " " + signal.direction + "

" +
    "P&L: " + sign + sf(pnl, 2) + "%
" +
    "Entry: " + sf(signal.entry, 2) + " | Exit: " + sf(exitPrice, 2) + "
" +
    "Reason: " + reason + "
" +
    "Type: " + entryType + "
" +
    "id=" + signal.id;

  return sendMessage(text);
}

export async function alertStatus(signals: any[], prices: Record<string, number>): Promise<boolean> {
  if (!Array.isArray(signals) || signals.length === 0) {
    return sendMessage("CXSwitch v37 — No active signals.");
  }

  const lines = signals.map(s => {
    if (!s || !s.pair) return "Invalid signal";
    const price = prices[s.pair] || s.entry;
    const rawPnl = s.direction === "LONG"
      ? ((price - s.entry) / s.entry) * 100
      : ((s.entry - price) / s.entry) * 100;
    const pnl = isFinite(rawPnl) ? rawPnl : 0;
    const sign = pnl >= 0 ? "+" : "";
    const emoji = pnl >= 0 ? "🟢" : "🔴";
    const entryType = s.entryType || s.entryMode || "OPEN";
    return emoji + " " + s.pair + " " + s.direction + " | " + entryType + " | " + sign + sf(pnl, 2) + "%";
  });

  return sendMessage("CXSwitch v37 Active Signals | " + lines.join(" | "));
}

export async function alertError(context: string, error: any): Promise<boolean> {
  const errStr = String(error).slice(0, 400);
  return sendMessage("CXSwitch v37 ERROR | Context: " + context + " | " + errStr);
}
