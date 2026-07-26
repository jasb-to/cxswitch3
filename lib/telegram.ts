// lib/telegram.ts — v46.1 Clean Notifications
// ============================================================
// Works with v46.1's Signal shape: no confidence, no ADX, no stoch.
// Reports primary trigger + confirmation, RR, and levels.
// ============================================================

import { Signal } from "./strategy";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN) console.warn("[TELEGRAM] TELEGRAM_BOT_TOKEN not set");
if (!CHAT_ID) console.warn("[TELEGRAM] TELEGRAM_CHAT_ID not set");

const BASE_URL = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : "";

function sf(v: any, d: number): string {
  const n = Number(v);
  return isFinite(n) ? n.toFixed(d) : "0";
}

function fmtDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

// ─── Core Sender ───────────────────────────────────────────

async function sendTelegram(method: string, payload: any): Promise<any> {
  if (!BASE_URL) {
    console.warn("[TELEGRAM] No bot token, skipping send");
    return null;
  }
  try {
    const res = await fetch(`${BASE_URL}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) console.error(`[TELEGRAM] API error: ${data.description}`);
    return data;
  } catch (err) {
    console.error(`[TELEGRAM] Network error: ${err}`);
    return null;
  }
}

export async function sendMessage(text: string, options?: { disable_notification?: boolean }): Promise<void> {
  if (!CHAT_ID) return;
  await sendTelegram("sendMessage", {
    chat_id: CHAT_ID,
    text: text.slice(0, 4096),
    parse_mode: "HTML",
    disable_notification: options?.disable_notification ?? false,
    disable_web_page_preview: true,
  });
}

// ─── Entry Alert ───────────────────────────────────────────

export async function sendAlert(signal: Signal): Promise<boolean> {
  if (!signal?.pair) {
    console.log("[TELEGRAM SKIP] Invalid signal");
    return false;
  }

  const emoji = signal.direction === "LONG" ? "🟢" : "🔴";
  const slPct = sf(Math.abs((signal.stop - signal.entry) / signal.entry) * 100, 1);
  const tpPct = sf(Math.abs((signal.target - signal.entry) / signal.entry) * 100, 1);

  const lines = [
    `${emoji} <b>ENTRY — ${signal.pair} ${signal.direction}</b>`,
    ``,
    `<b>Entry:</b>  $${sf(signal.entry, 2)}`,
    `<b>Stop:</b>   $${sf(signal.stop, 2)}  (${slPct}%)`,
    `<b>Target:</b> $${sf(signal.target, 2)}  (${tpPct}%)`,
    ``,
    `<b>RR:</b> ${signal.rr ? sf(signal.rr, 2) : "N/A"}`,
    `<b>Trigger:</b> ${signal.primaryTrigger} + ${signal.confirmation}`,
    ``,
    `<code>v${signal.version || 46} | ${fmtDate(signal.timestamp)}</code>`,
    `<code>ID: ${signal.id}</code>`,
  ];

  await sendMessage(lines.join("\n"), { disable_notification: false });
  return true;
}

// ─── Exit Alert ────────────────────────────────────────────

export async function sendExitAlert(
  signal: Signal,
  exitPrice: number,
  reason: string
): Promise<boolean> {
  if (!signal?.pair) {
    console.log("[TELEGRAM SKIP] Invalid signal for exit");
    return false;
  }

  const rawPnl = signal.direction === "LONG"
    ? ((exitPrice - signal.entry) / signal.entry) * 100
    : ((signal.entry - exitPrice) / signal.entry) * 100;
  const pnl = isFinite(rawPnl) ? rawPnl : 0;
  const pnlEmoji = pnl >= 0 ? "🟢" : "🔴";

  const lines = [
    `${pnlEmoji} <b>EXIT — ${signal.pair} ${signal.direction}</b>`,
    ``,
    `<b>P&L:</b> ${pnl >= 0 ? "+" : ""}${sf(pnl, 2)}%`,
    `<b>Entry:</b> $${sf(signal.entry, 2)} | <b>Exit:</b> $${sf(exitPrice, 2)}`,
    `<b>Reason:</b> ${reason.replace(/_/g, " ")}`,
    ``,
    `<code>v${signal.version || 46} | ${fmtDate(Date.now())}</code>`,
    `<code>ID: ${signal.id}</code>`,
  ];

  await sendMessage(lines.join("\n"), { disable_notification: false });
  return true;
}

// ─── Status Update ───────────────────────────────────────────

export async function alertStatus(signals: Signal[], prices: Record<string, number>): Promise<boolean> {
  if (!signals.length) {
    await sendMessage("📊 <b>CXSwitch v46</b> — No active signals.");
    return true;
  }

  const lines = signals.map(s => {
    const price = prices[s.pair] || s.entry;
    const rawPnl = s.direction === "LONG"
      ? ((price - s.entry) / s.entry) * 100
      : ((s.entry - price) / s.entry) * 100;
    const pnl = isFinite(rawPnl) ? rawPnl : 0;
    const emoji = pnl >= 0 ? "🟢" : "🔴";
    return `${emoji} ${s.pair} ${s.direction} | ${sf(pnl, 2)}%`;
  });

  await sendMessage(`📊 <b>Active Signals</b>\n\n${lines.join("\n")}`);
  return true;
}

// ─── Error Alert ───────────────────────────────────────────

export async function alertError(context: string, error: any): Promise<boolean> {
  const errStr = String(error).slice(0, 400);
  await sendMessage(`❌ <b>ERROR</b> | ${context}\n\n<code>${errStr}</code>`);
  return true;
}

// ─── Admin Alert (optional) ────────────────────────────────

const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID || "";

export async function notifyAdmin(message: string, error?: Error): Promise<void> {
  if (!ADMIN_ID) return;
  const text = error
    ? `❌ <b>ADMIN ALERT</b>\n\n${message}\n\n<pre>${error.stack || error.message}</pre>`
    : `🔔 <b>ADMIN ALERT</b>\n\n${message}`;
  await sendTelegram("sendMessage", {
    chat_id: ADMIN_ID,
    text: text.slice(0, 4096),
    parse_mode: "HTML",
  });
}
