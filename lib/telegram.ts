// ============================================================
// CXSwitch Telegram Bot — v41 "Trendline Break" Notifications
// ============================================================
// MERGED: v37 legacy functions (sendAlert, sendExitAlert, alertError) 
//         + v41 new functions (notifyEntry, notifyExit, notifySnapshot, etc.)
// Backward compatible with existing cron/api routes.
// ============================================================

import { Signal } from "./strategy";

// ─── Legacy v37 Config ───
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN) console.warn("[TELEGRAM] TELEGRAM_BOT_TOKEN not set");
if (!CHAT_ID) console.warn("[TELEGRAM] TELEGRAM_CHAT_ID not set");

// ─── v41 Config ───
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const TELEGRAM_ADMIN_ID = process.env.TELEGRAM_ADMIN_ID || "";
const BASE_URL = TELEGRAM_BOT_TOKEN ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}` : "";

// ─── Emoji Map (v41) ───
const EMOJI = {
  LONG: "🟢",
  SHORT: "🔴",
  PULLBACK: "🎯",
  BREAKOUT: "🚀",
  FADE: "⚡",
  STOP: "🛑",
  TARGET: "✅",
  TRAIL: "🛡️",
  TREND: "📈",
  REVERSAL: "🔄",
  ADX: "📊",
  VOLUME: "📢",
  CONFIDENCE: "⭐",
  RR: "⚖️",
  SIZE: "💰",
  TRENDLINE: "〰️",
  VERSION: "🔧",
  ALERT: "🔔",
  ERROR: "❌",
  COOLDOWN: "⏳",
  WATCH: "👁️",
  READY: "🔥",
};

// ─── Helpers ───
function sf(v: any, d: number): string {
  const n = Number(v);
  return isFinite(n) ? n.toFixed(d) : "0";
}

function pct(v: number): string {
  return `${sf(v * 100, 2)}%`;
}

function fmtDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

// Escape for Telegram MarkdownV2
function escapeMarkdown(text: string): string {
  return text
    .replace(/_/g, "\\_")
    .replace(/\*/g, "\\*")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/~/g, "\\~")
    .replace(/`/g, "\\`")
    .replace(/>/g, "\\>")
    .replace(/#/g, "\\#")
    .replace(/\+/g, "\\+")
    .replace(/-/g, "\\-")
    .replace(/=/g, "\\=")
    .replace(/\|/g, "\\|")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\./g, "\\.")
    .replace(/!/g, "\\!");
}

// ─── Legacy v37: Simple HTML Sender ───
async function sendMessageLegacy(text: string, parseMode: "HTML" | "Markdown" = "HTML"): Promise<boolean> {
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

// ─── v41: MarkdownV2 Sender ───
async function sendTelegram(method: string, payload: any): Promise<any> {
  if (!BASE_URL) {
    console.warn("[TELEGRAM] No bot token configured, skipping send");
    return null;
  }
  try {
    const res = await fetch(`${BASE_URL}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error(`[TELEGRAM] API error: ${data.description}`);
    }
    return data;
  } catch (err) {
    console.error(`[TELEGRAM] Network error: ${err}`);
    return null;
  }
}

export async function sendMessage(text: string, options?: { parse_mode?: string; disable_notification?: boolean }): Promise<void> {
  if (!TELEGRAM_CHAT_ID) return;
  await sendTelegram("sendMessage", {
    chat_id: TELEGRAM_CHAT_ID,
    text: escapeMarkdown(text),
    parse_mode: options?.parse_mode || "MarkdownV2",
    disable_notification: options?.disable_notification ?? false,
    disable_web_page_preview: true,
  });
}

export async function sendPhoto(photoUrl: string, caption: string): Promise<void> {
  if (!TELEGRAM_CHAT_ID) return;
  await sendTelegram("sendPhoto", {
    chat_id: TELEGRAM_CHAT_ID,
    photo: photoUrl,
    caption: escapeMarkdown(caption),
    parse_mode: "MarkdownV2",
  });
}

// ============================================================
// LEGACY v37 EXPORTS (used by cron/api routes)
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
  if (type === "PULLBACK") return "PULLBACK ENTRY";
  if (type === "FADE") return "FADE ENTRY";
  return "ENTRY";
}

function getPositionSize(entryType: string, entryTier: string, scale: string): string {
  const type = entryType?.toUpperCase() || "";
  const tier = entryTier?.toUpperCase() || "";
  const sc = scale?.toUpperCase() || "";

  if (type === "EARLY") return "50% STARTER";
  if (type === "RETEST" || sc === "ENTRY_1") return "FULL SIZE";
  if (type === "BREAKOUT" || sc === "ENTRY_2") return "FULL SIZE";
  if (sc === "ADD") return "ADD POSITION";
  if (type === "PULLBACK") return "FULL SIZE";
  if (type === "FADE") return "50% SIZE";
  return "FULL SIZE";
}

export async function sendAlert(signal: any): Promise<boolean> {
  if (!signal || !signal.pair) {
    console.log("[TELEGRAM SKIP] Invalid signal object");
    return false;
  }

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

  const text = emoji + " " + label + " — " + pair + "\n\n" +
    "Direction: " + direction + "\n" +
    "Confidence: " + sf(confidence, 0) + "%\n\n" +
    "Position:\n" + size + "\n\n" +
    "Entry: " + entry + " | Stop: " + stop + " | Target: " + target + "\n" +
    "RR " + rr + " | SL " + slPct + "% | TP " + tpPct + "%\n" +
    "id=" + signal.id;

  return sendMessageLegacy(text);
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

  const text = emoji + " EXIT — " + signal.pair + " " + signal.direction + "\n\n" +
    "P&L: " + sign + sf(pnl, 2) + "%\n" +
    "Entry: " + sf(signal.entry, 2) + " | Exit: " + sf(exitPrice, 2) + "\n" +
    "Reason: " + reason + "\n" +
    "Type: " + entryType + "\n" +
    "id=" + signal.id;

  return sendMessageLegacy(text);
}

export async function alertStatus(signals: any[], prices: Record<string, number>): Promise<boolean> {
  if (!Array.isArray(signals) || signals.length === 0) {
    return sendMessageLegacy("CXSwitch v41 — No active signals.");
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

  return sendMessageLegacy("CXSwitch v41 Active Signals | " + lines.join(" | "));
}

export async function alertError(context: string, error: any): Promise<boolean> {
  const errStr = String(error).slice(0, 400);
  return sendMessageLegacy("CXSwitch v41 ERROR | Context: " + context + " | " + errStr);
}

// ============================================================
// v41 NEW EXPORTS (for dashboard and new features)
// ============================================================

export interface MarketSnapshot {
  pair: string;
  price: number;
  bias: { direction: string; strength: number } | null;
  trend1d: { direction: string; strength: string } | null;
  trend4h: { direction: string; strength: string } | null;
  stoch4h: { k: number; d: number };
  stoch1h: { k: number; d: number };
  stoch15m: { k: number; d: number };
  volumeConfirmed: boolean;
  isPullback: boolean;
  pullbackTier: string | null;
  readiness: number;
  readinessLabel: string;
  adx: number;
  rsi: number;
  ema21: number;
  distToEMA21: number;
  emaAligned: boolean;
  recommendedAction: string | null;
  entryTier: string | null;
  positionSize: string | null;
  signal: Signal | null;
  debug: string[];
}

export async function notifyEntry(signal: Signal): Promise<void> {
  const dirEmoji = signal.direction === "LONG" ? EMOJI.LONG : EMOJI.SHORT;
  const entryEmoji = signal.entryType === "PULLBACK" ? EMOJI.PULLBACK
    : signal.entryType === "BREAKOUT" ? EMOJI.BREAKOUT
    : EMOJI.FADE;

  const lines: string[] = [
    `${dirEmoji} *${signal.pair} ${signal.direction} ${entryEmoji}*`,
    ``,
    `*Entry:*  $${sf(signal.entry, 2)}`,
    `*Stop:*   $${sf(signal.stop, 2)}`,
    `*Target:* $${sf(signal.target, 2)}`,
    `*Risk:*   $${sf(Math.abs(signal.entry - signal.stop), 2)}`,
    ``,
    `${EMOJI.RR} *RR:* ${signal.rr ? sf(signal.rr, 2) : "N/A"} | ${EMOJI.CONFIDENCE} *Conf:* ${signal.confidence}%`,
    `${EMOJI.SIZE} *Size:* ${signal.positionSizePct ? pct(signal.positionSizePct) : "2%"}`,
  ];

  if (signal.trendlinePrice) {
    lines.push(`${EMOJI.TRENDLINE} *Trendline:* $${sf(signal.trendlinePrice, 2)}`);
  }

  if (signal.adx !== undefined) {
    lines.push(`${EMOJI.ADX} *1D ADX:* ${sf(signal.adx, 1)}`);
  }

  if (signal.stochK !== undefined && signal.stochD !== undefined) {
    lines.push(`📉 *4H Stoch:* K=${sf(signal.stochK, 1)} D=${sf(signal.stochD, 1)}`);
  }

  if (signal.volumeConfirmed) {
    lines.push(`${EMOJI.VOLUME} *Volume confirmed*`);
  }

  if (signal.conflictEntry) {
    lines.push(`⚠️ *Timeframe conflict* — 1D/4H misaligned, reduced confidence`);
  }

  lines.push(
    ``,
    `${EMOJI.VERSION} *v${signal.version || 41}* | ${fmtDate(signal.timestamp)}`,
    `\`ID: ${signal.id}\``
  );

  await sendMessage(lines.join("\n"), { disable_notification: false });
}

export async function notifyExit(
  signal: Signal,
  exitPrice: number,
  reason: string,
  pnl?: number
): Promise<void> {
  const dirEmoji = signal.direction === "LONG" ? EMOJI.LONG : EMOJI.SHORT;
  const reasonEmoji = reason === "stop_loss" ? EMOJI.STOP
    : reason === "target_hit" ? EMOJI.TARGET
    : reason === "trailing_stop" ? EMOJI.TRAIL
    : reason === "1d_trend_reversed" ? EMOJI.REVERSAL
    : EMOJI.ALERT;

  const pnlPct = pnl !== undefined ? pct(pnl) : "N/A";
  const pnlEmoji = pnl !== undefined && pnl > 0 ? "🟢" : pnl !== undefined && pnl < 0 ? "🔴" : "⚪";

  const lines: string[] = [
    `${dirEmoji} *${signal.pair} EXIT ${reasonEmoji}*`,
    ``,
    `*Entry:*  $${sf(signal.entry, 2)}`,
    `*Exit:*   $${sf(exitPrice, 2)}`,
    `*Reason:* ${reason.replace(/_/g, " ")}`,
  ];

  if (pnl !== undefined) {
    lines.push(`*PnL:*    ${pnlEmoji} ${pnlPct}`);
  }

  const r = signal.rr ? Math.abs(exitPrice - signal.entry) / Math.abs(signal.entry - signal.stop) : 0;
  lines.push(`*R:*      ${sf(r, 2)}R`);

  lines.push(
    ``,
    `${EMOJI.VERSION} *v${signal.version || 41}* | ${fmtDate(Date.now())}`,
    `\`ID: ${signal.id}\``
  );

  await sendMessage(lines.join("\n"), { disable_notification: false });
}

export async function notifySnapshot(snapshot: MarketSnapshot): Promise<void> {
  const dirEmoji = snapshot.bias?.direction === "LONG" ? EMOJI.LONG
    : snapshot.bias?.direction === "SHORT" ? EMOJI.SHORT
    : "⚪";

  const readinessEmoji = snapshot.readiness >= 80 ? EMOJI.READY
    : snapshot.readiness >= 60 ? "🟡"
    : snapshot.readiness >= 40 ? EMOJI.WATCH
    : EMOJI.COOLDOWN;

  const lines: string[] = [
    `${dirEmoji} *${snapshot.pair} Snapshot*`,
    ``,
    `*Price:* $${sf(snapshot.price, 2)} | *EMA21:* $${sf(snapshot.ema21, 2)} (${sf(snapshot.distToEMA21, 2)}%)`,
    ``,
    `*1D Trend:* ${snapshot.trend1d?.direction || "—"} ${snapshot.trend1d?.strength || ""}`,
    `*4H Trend:* ${snapshot.trend4h?.direction || "—"} ${snapshot.trend4h?.strength || ""}`,
    `*ADX:* ${sf(snapshot.adx, 1)} | *RSI:* ${sf(snapshot.rsi, 1)}`,
    ``,
    `*4H Stoch:* K=${sf(snapshot.stoch4h.k, 1)} D=${sf(snapshot.stoch4h.d, 1)}`,
    `*1H Stoch:* K=${sf(snapshot.stoch1h.k, 1)} D=${sf(snapshot.stoch1h.d, 1)}`,
    `*15M Stoch:* K=${sf(snapshot.stoch15m.k, 1)} D=${sf(snapshot.stoch15m.d, 1)}`,
  ];

  if (snapshot.isPullback) {
    lines.push(`${EMOJI.PULLBACK} *Pullback active:* ${snapshot.pullbackTier || "detected"}`);
  }

  if (snapshot.volumeConfirmed) {
    lines.push(`${EMOJI.VOLUME} *Volume spike confirmed*`);
  }

  if (snapshot.emaAligned) {
    lines.push(`✅ *EMA aligned* with 1D bias`);
  } else {
    lines.push(`⚠️ *EMA misaligned* — 1D/4H conflict`);
  }

  lines.push(
    ``,
    `${readinessEmoji} *Readiness:* ${snapshot.readinessLabel} (${snapshot.readiness}%)`
  );

  if (snapshot.recommendedAction) {
    lines.push(`🔔 *Action:* ${snapshot.recommendedAction}`);
  }

  if (snapshot.entryTier) {
    lines.push(`🎯 *Entry tier:* ${snapshot.entryTier}`);
  }

  if (snapshot.positionSize) {
    lines.push(`${EMOJI.SIZE} *Size:* ${snapshot.positionSize}`);
  }

  lines.push(`\`v41 | ${fmtDate(Date.now())}\``);

  await sendMessage(lines.join("\n"), { disable_notification: true });
}

export async function notifyDailySummary(
  date: string,
  signals: Signal[],
  exits: { signal: Signal; exitPrice: number; reason: string; pnl?: number }[]
): Promise<void> {
  const totalSignals = signals.length;
  const totalExits = exits.length;
  const winCount = exits.filter(e => (e.pnl || 0) > 0).length;
  const lossCount = exits.filter(e => (e.pnl || 0) < 0).length;
  const totalPnL = exits.reduce((sum, e) => sum + (e.pnl || 0), 0);

  const lines: string[] = [
    `📅 *Daily Summary — ${date}*`,
    ``,
    `*Signals:* ${totalSignals} | *Exits:* ${totalExits}`,
    `*Wins:* ${winCount} 🟢 | *Losses:* ${lossCount} 🔴`,
    `*Net PnL:* ${totalPnL > 0 ? "🟢" : totalPnL < 0 ? "🔴" : "⚪"} ${pct(totalPnL)}`,
    ``,
  ];

  if (exits.length > 0) {
    lines.push(`*Exit breakdown:*`);
    for (const e of exits) {
      const pnlEmoji = (e.pnl || 0) > 0 ? "🟢" : (e.pnl || 0) < 0 ? "🔴" : "⚪";
      lines.push(`  ${e.signal.pair} ${e.signal.direction} ${pnlEmoji} ${pct(e.pnl || 0)} — ${e.reason.replace(/_/g, " ")}`);
    }
  }

  lines.push(`\`v41 | CXSwitch Trendline Break\``);

  await sendMessage(lines.join("\n"), { disable_notification: true });
}

export async function notifyAdmin(message: string, error?: Error): Promise<void> {
  if (!TELEGRAM_ADMIN_ID) return;
  const emoji = error ? EMOJI.ERROR : EMOJI.ALERT;
  const text = error
    ? `${emoji} *ADMIN ALERT*\n\n${message}\n\n\`\`\`${error.stack || error.message}\`\`\``
    : `${emoji} *ADMIN ALERT*\n\n${message}`;
  await sendTelegram("sendMessage", {
    chat_id: TELEGRAM_ADMIN_ID,
    text: escapeMarkdown(text),
    parse_mode: "MarkdownV2",
  });
}

export async function notifyCooldown(pair: string, minutesLeft: number, reason: string): Promise<void> {
  await sendMessage(
    `${EMOJI.COOLDOWN} *${pair} on cooldown*\n\nReason: ${reason}\nRemaining: ${minutesLeft} min\n\n\`v41\``,
    { disable_notification: true }
  );
}

export async function notifyError(context: string, error: Error): Promise<void> {
  console.error(`[TELEGRAM] ${context}:`, error);
  await notifyAdmin(`${context} failed`, error);
}

export async function setWebhook(url: string): Promise<boolean> {
  if (!BASE_URL) return false;
  const data = await sendTelegram("setWebhook", { url });
  return data?.ok ?? false;
}

export async function deleteWebhook(): Promise<boolean> {
  if (!BASE_URL) return false;
  const data = await sendTelegram("deleteWebhook", {});
  return data?.ok ?? false;
}

export async function getBotInfo(): Promise<any> {
  if (!BASE_URL) return null;
  return sendTelegram("getMe", {});
}
