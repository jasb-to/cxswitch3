// app/api/signals/route.ts — v58 dashboard state API
import { NextResponse } from "next/server";
import { getActiveSignals, getSignalHistory, getMarketData, getLastCronRun } from "@/lib/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const activeSignals = await getActiveSignals();
  const signalHistory = await getSignalHistory();
  const marketData = await getMarketData();
  const lastCronRun = await getLastCronRun();
  const now = Date.now();

  const enrichedActive = activeSignals.map((s) => ({
    ...s,
    scale: s.type,
    expectedMove: s.entry && s.target ? Math.round(Math.abs(s.target - s.entry) / s.entry * 1000) / 10 : 0,
    meta: { status: s.status, ageMinutes: Math.round((now - s.timestamp) / 60000), actionable: s.status === "ACTIVE", state: "POSITION_ACTIVE" },
  }));

  const enrichedHistory = signalHistory.map((h) => ({
    ...h,
    scale: h.type,
    meta: { ageMinutes: Math.round((now - h.timestamp) / 60000), status: h.status },
  }));

  // The dashboard log is deliberately an alert/engine view, not every 10-minute scan.
  // This keeps the useful audit trail without bringing back alert spam.
  const historyLogs = signalHistory
    .slice()
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 20)
    .map((h) => `[ALERT] ${h.pair} — ${h.direction} ${h.type} @ ${h.entry} | TP ${h.target} | SL ${h.stop} | ${h.status}`);

  const marketLogs = (Array.isArray(marketData) ? marketData : []).map((m: any) =>
    `[PAIR] ${m.pair} — ${m.trend || "NO TREND"} | ${m.location || "—"} | ${m.trigger || "WAITING"} | Price ${m.price} | TL ${m.trendlinePrice || "—"}`
  );

  const logs = [
    `[CRON] Last run ${lastCronRun ? new Date(lastCronRun).toISOString() : "not recorded"}`,
    ...historyLogs,
    ...marketLogs,
    `[CRON] State: active=${enrichedActive.length} marketData=${Array.isArray(marketData) ? marketData.length : 0} history=${signalHistory.length}`,
  ].slice(0, 32);

  const response = NextResponse.json({
    activeSignals: enrichedActive,
    signalHistory: enrichedHistory,
    marketData: Array.isArray(marketData) ? marketData : [],
    logs,
    system: { lastCronRun, lastCronAgeMs: lastCronRun ? now - lastCronRun : null, activePositions: enrichedActive.length },
    updatedAt: new Date(now).toISOString(),
  });
  response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
  return response;
}
