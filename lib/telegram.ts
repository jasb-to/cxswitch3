// ============================================================
// CXSwitch Telegram Bot — v41 "Trendline Break" Notifications
// ============================================================
// MERGED: v37 legacy functions (sendAlert, sendExitAlert, alertError) 
//         + v41 new functions (notifyEntry, notifyExit, notifySnapshot, etc.)
// Backward compatible with existing cron/api routes.
//
// FIX: v41 sendMessage no longer escapes markdown (breaks emojis).
//      Legacy HTML sender kept as default for alerts.
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

// ─── Legacy v37: Simple HTML Sender (default for alerts) ───
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

// ─── v41: Raw API Sender (no markdown escaping) ───
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

// v41 sendMessage — uses HTML parse mode to avoid markdown escaping breaking emojis
export async function sendMessage(text: string, options?: { parse_mode?: string; disable_notification?: boolean }): Promise<void> {
  if (!TELEGRAM_CHAT_ID) return;
  await sendTelegram("sendMessage", {
    chat_id: TELEGRAM_CHAT_ID,
    text: text,
    parse_mode: "HTML",
    disable_notification: options?.disable_notification ?? false,
    disable_web_page_preview: true,
  });
}

export async function sendPhoto(photoUrl: string, caption: string): Promise<void> {
  if (!TELEGRAM_CHAT_ID) return;
  await sendTelegram("sendPhoto", {
    chat_id: TELEGRAM_CHAT_ID,
    photo: photoUrl,
    caption: caption,
    parse_mode: "HTML",
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
    `${dirEmoji} <b>${signal.pair} ${signal.direction} ${entryEmoji}</b>`,
    ``,
    `<b>Entry:</b>  $${sf(signal.entry, 2)}`,
    `<b>Stop:</b>   $${sf(signal.stop, 2)}`,
    `<b>Target:</b> $${sf(signal.target, 2)}`,
    `<b>Risk:</b>   $${sf(Math.abs(signal.entry - signal.stop), 2)}`,
    ``,
    `${EMOJI.RR} <b>RR:</b> ${signal.rr ? sf(signal.rr, 2) : "N/A"} | ${EMOJI.CONFIDENCE} <b>Conf:</b> ${signal.confidence}%`,
    `${EMOJI.SIZE} <b>Size:</b> ${signal.positionSizePct ? pct(signal.positionSizePct) : "2%"}`,
  ];

  if (signal.trendlinePrice) {
    lines.push(`${EMOJI.TRENDLINE} <b>Trendline:</b> $${sf(signal.trendlinePrice, 2)}`);
  }

  if (signal.adx !== undefined) {
    lines.push(`${EMOJI.ADX} <b>1D ADX:</b> ${sf(signal.adx, 1)}`);
  }

  if (signal.stochK !== undefined && signal.stochD !== undefined) {
    lines.push(`📉 <b>4H Stoch:</b> K=${sf(signal.stochK, 1)} D=${sf(signal.stochD, 1)}`);
  }

  if (signal.volumeConfirmed) {
    lines.push(`${EMOJI.VOLUME} <b>Volume confirmed</b>`);
  }

  if (signal.conflictEntry) {
    lines.push(`⚠️ <b>Timeframe conflict</b> — 1D/4H misaligned, reduced confidence`);
  }

  lines.push(
    ``,
    `${EMOJI.VERSION} <b>v${signal.version || 41}</b> | ${fmtDate(signal.timestamp)}`,
    `<code>ID: ${signal.id}</code>`
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
    `${dirEmoji} <b>${signal.pair} EXIT ${reasonEmoji}</b>`,
    ``,
    `<b>Entry:</b>  $${sf(signal.entry, 2)}`,
    `<b>Exit:</b>   $${sf(exitPrice, 2)}`,
    `<b>Reason:</b> ${reason.replace(/_/g, " ")}`,
  ];

  if (pnl !== undefined) {
    lines.push(`<b>PnL:</b>    ${pnlEmoji} ${pnlPct}`);
  }

  const r = signal.rr ? Math.abs(exitPrice - signal.entry) / Math.abs(signal.entry - signal.stop) : 0;
  lines.push(`<b>R:</b>      ${sf(r, 2)}R`);

  lines.push(
    ``,
    `${EMOJI.VERSION} <b>v${signal.version || 41}</b> | ${fmtDate(Date.now())}`,
    `<code>ID: ${signal.id}</code>`
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
    `${dirEmoji} <b>${snapshot.pair} Snapshot</b>`,
    ``,
    `<b>Price:</b> $${sf(snapshot.price, 2)} | <b>EMA21:</b> $${sf(snapshot.ema21, 2)} (${sf(snapshot.distToEMA21, 2)}%)`,
    ``,
    `<b>1D Trend:</b> ${snapshot.trend1d?.direction || "—"} ${snapshot.trend1d?.strength || ""}`,
    `<b>4H Trend:</b> ${snapshot.trend4h?.direction || "—"} ${snapshot.trend4h?.strength || ""}`,
    `<b>ADX:</b> ${sf(snapshot.adx, 1)} | <b>RSI:</b> ${sf(snapshot.rsi, 1)}`,
    ``,
    `<b>4H Stoch:</b> K=${sf(snapshot.stoch4h.k, 1)} D=${sf(snapshot.stoch4h.d, 1)}`,
    `<b>1H Stoch:</b> K=${sf(snapshot.stoch1h.k, 1)} D=${sf(snapshot.stoch1h.d, 1)}`,
    `<b>15M Stoch:</b> K=${sf(snapshot.stoch15m.k, 1)} D=${sf(snapshot.stoch15m.d, 1)}`,
  ];

  if (snapshot.isPullback) {
    lines.push(`${EMOJI.PULLBACK} <b>Pullback active:</b> ${snapshot.pullbackTier || "detected"}`);
  }

  if (snapshot.volumeConfirmed) {
    lines.push(`${EMOJI.VOLUME} <b>Volume spike confirmed</b>`);
  }

  if (snapshot.emaAligned) {
    lines.push(`✅ <b>EMA aligned</b> with 1D bias`);
  } else {
    lines.push(`⚠️ <b>EMA misaligned</b> — 1D/4H conflict`);
  }

  lines.push(
    ``,
    `${readinessEmoji} <b>Readiness:</b> ${snapshot.readinessLabel} (${snapshot.readiness}%)`
  );

  if (snapshot.recommendedAction) {
    lines.push(`🔔 <b>Action:</b> ${snapshot.recommendedAction}`);
  }

  if (snapshot.entryTier) {
    lines.push(`🎯 <b>Entry tier:</b> ${snapshot.entryTier}`);
  }

  if (snapshot.positionSize) {
    lines.push(`${EMOJI.SIZE} <b>Size:</b> ${snapshot.positionSize}`);
  }

  lines.push(`<code>v41 | ${fmtDate(Date.now())}</code>`);

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
    `📅 <b>Daily Summary — ${date}</b>`,
    ``,
    `<b>Signals:</b> ${totalSignals} | <b>Exits:</b> ${totalExits}`,
    `<b>Wins:</b> ${winCount} 🟢 | <b>Losses:</b> ${lossCount} 🔴`,
    `<b>Net PnL:</b> ${totalPnL > 0 ? "🟢" : totalPnL < 0 ? "🔴" : "⚪"} ${pct(totalPnL)}`,
    ``,
  ];

  if (exits.length > 0) {
    lines.push(`<b>Exit breakdown:</b>`);
    for (const e of exits) {
      const pnlEmoji = (e.pnl || 0) > 0 ? "🟢" : (e.pnl || 0) < 0 ? "🔴" : "⚪";
      lines.push(`  ${e.signal.pair} ${e.signal.direction} ${pnlEmoji} ${pct(e.pnl || 0)} — ${e.reason.replace(/_/g, " ")}`);
    }
  }

  lines.push(`<code>v41 | CXSwitch Trendline Break</code>`);

  await sendMessage(lines.join("\n"), { disable_notification: true });
}

export async function notifyAdmin(message: string, error?: Error): Promise<void> {
  if (!TELEGRAM_ADMIN_ID) return;
  const emoji = error ? EMOJI.ERROR : EMOJI.ALERT;
  const text = error
    ? `${emoji} <b>ADMIN ALERT</b>\n\n${message}\n\n<pre>${error.stack || error.message}</pre>`
    : `${emoji} <b>ADMIN ALERT</b>\n\n${message}`;
  await sendTelegram("sendMessage", {
    chat_id: TELEGRAM_ADMIN_ID,
    text: text,
    parse_mode: "HTML",
  });
}

export async function notifyCooldown(pair: string, minutesLeft: number, reason: string): Promise<void> {
  await sendMessage(
    `${EMOJI.COOLDOWN} <b>${pair} on cooldown</b>\n\nReason: ${reason}\nRemaining: ${minutesLeft} min\n\n<code>v41</code>`,
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
