"use client";

import { useState, useEffect, useCallback } from "react";

interface RegimeData {
  direction: string | null;
  strength: string;
  confidence: number;
  score: number;
  reason: string[];
}

interface TrendContext {
  direction: string;
  strength: string;
}

interface EntryCandidate {
  eligible: boolean;
  confidence: number;
  rejectionReason: string | null;
}

interface EntryCandidates {
  pullback: EntryCandidate;
  rejection: EntryCandidate;
  breakout: EntryCandidate;
}

interface MarketSnapshot {
  pair: string;
  price: number;
  trend: string;
  regime: RegimeData;
  adx?: number;
  rsi?: number;
  stochK?: number;
  stochD?: number;
  stoch1hK?: number;
  stoch1hD?: number;
  trend1h?: TrendContext;
  trend4h?: TrendContext;
  trend1d?: TrendContext;
  entryCandidates?: EntryCandidates;
  debug?: string[];
  rejectionStage?: string | null;
}

const PAIRS = ["BTC/USD", "ETH/USD", "SOL/USD", "HYPE/USD"];

// ─── Helpers ───

function getDirectionColor(direction: string | null | undefined): string {
  if (!direction) return "text-gray-400";
  const d = String(direction).toUpperCase();
  if (d === "LONG" || d === "BULLISH") return "text-green-400";
  if (d === "SHORT" || d === "BEARISH") return "text-red-400";
  return "text-gray-400";
}

function getStrengthBadge(strength: string): string {
  const s = (strength || "").toUpperCase();
  if (s === "STRONG") return "bg-green-500/20 text-green-400 border-green-500/30";
  if (s === "MODERATE" || s === "MEDIUM") return "bg-yellow-500/20 text-yellow-400 border-yellow-500/30";
  if (s === "WEAK") return "bg-orange-500/20 text-orange-400 border-orange-500/30";
  return "bg-gray-700/50 text-gray-400 border-gray-600/30";
}

function getAdxLabel(adx: number | undefined): string {
  if (adx === undefined) return "—";
  if (adx > 25) return "TRENDING";
  if (adx > 20) return "MODERATE";
  return "WEAK";
}

function getAdxColor(adx: number | undefined): string {
  if (adx === undefined) return "text-gray-500";
  if (adx > 25) return "text-green-400";
  if (adx > 20) return "text-yellow-400";
  return "text-red-400";
}

function getConfidenceColor(conf: number): string {
  if (conf >= 70) return "text-green-400";
  if (conf >= 50) return "text-yellow-400";
  if (conf >= 30) return "text-orange-400";
  return "text-red-400";
}

function getRejectionStageColor(stage: string | null): string {
  if (!stage) return "text-gray-400";
  if (stage.includes("Regime")) return "text-purple-400";
  if (stage.includes("Exhaustion")) return "text-red-400";
  if (stage.includes("Confidence")) return "text-orange-400";
  if (stage.includes("RR")) return "text-yellow-400";
  return "text-gray-400";
}

// ─── Sub-components ───

function RegimePanel({ regime }: { regime: RegimeData }) {
  return (
    <div className="mb-3 p-2.5 bg-gray-800/60 rounded-lg border border-gray-700/50">
      <div className="text-[10px] text-gray-500 mb-2 uppercase tracking-wider font-semibold">Regime Diagnostics</div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
        <div className="flex justify-between">
          <span className="text-gray-500">Direction</span>
          <span className={`font-bold ${getDirectionColor(regime.direction)}`}>{regime.direction || "NEUTRAL"}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Strength</span>
          <span className={`font-bold ${regime.strength === "STRONG" ? "text-green-400" : regime.strength === "MODERATE" ? "text-yellow-400" : regime.strength === "WEAK" ? "text-orange-400" : "text-gray-400"}`}>{regime.strength}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Confidence</span>
          <span className="font-mono font-semibold text-gray-200">{regime.confidence}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Score</span>
          <span className="font-mono font-semibold text-gray-200">{regime.score}</span>
        </div>
      </div>
      {regime.reason.length > 0 && (
        <div className="mt-2">
          <div className="text-[10px] text-gray-500 mb-1">Reasons</div>
          <div className="flex flex-wrap gap-1">
            {regime.reason.map((r, i) => (
              <span key={i} className="text-[10px] px-1.5 py-0.5 bg-gray-700/50 rounded text-gray-400 font-mono">{r}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function EntryCandidatesPanel({ candidates }: { candidates?: EntryCandidates }) {
  if (!candidates) return null;

  const modes: Array<{ key: keyof EntryCandidates; label: string }> = [
    { key: "pullback", label: "PULLBACK" },
    { key: "rejection", label: "REJECTION" },
    { key: "breakout", label: "BREAKOUT" },
  ];

  return (
    <div className="mb-3 p-2.5 bg-gray-800/60 rounded-lg border border-gray-700/50">
      <div className="text-[10px] text-gray-500 mb-2 uppercase tracking-wider font-semibold">Entry Candidates</div>
      <div className="space-y-2">
        {modes.map(({ key, label }) => {
          const c = candidates[key];
          return (
            <div key={key} className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${c.eligible ? "bg-green-500" : "bg-red-500"}`}></span>
                <span className="font-mono text-gray-300 w-20">{label}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${c.eligible ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
                  {c.eligible ? "ELIGIBLE" : "REJECTED"}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-gray-500">conf: <span className={`font-mono font-semibold ${getConfidenceColor(c.confidence)}`}>{c.confidence}</span></span>
                {c.rejectionReason && (
                  <span className="text-[10px] text-red-400 max-w-[180px] truncate" title={c.rejectionReason}>{c.rejectionReason}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DebugPanel({ debug, pair }: { debug?: string[]; pair: string }) {
  const [open, setOpen] = useState(false);
  if (!debug || debug.length === 0) return null;

  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[10px] text-gray-500 hover:text-gray-300 transition w-full"
      >
        <span className={`transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
        <span className="font-mono">Strategy Debug ({debug.length} lines)</span>
      </button>
      {open && (
        <div className="mt-1.5 p-2 bg-gray-950 rounded border border-gray-800 max-h-48 overflow-y-auto">
          {debug.map((line, i) => (
            <div key={i} className="text-[10px] font-mono text-gray-500 leading-relaxed">
              <span className="text-gray-700 mr-1.5">{String(i + 1).padStart(2, "0")}</span>
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NoSignalBanner({ regime, rejectionStage }: { regime: RegimeData; rejectionStage?: string | null }) {
  if (regime.direction && regime.direction !== "NEUTRAL") return null;

  return (
    <div className="mb-3 p-3 bg-purple-900/20 border border-purple-700/30 rounded-lg">
      <div className="flex items-center gap-2">
        <span className="text-purple-400 text-lg">⊘</span>
        <div>
          <div className="text-xs font-semibold text-purple-300">No signal because higher-timeframe regime is neutral.</div>
          {rejectionStage && (
            <div className="text-[10px] text-purple-400/70 mt-0.5 font-mono">Stage: {rejectionStage}</div>
          )}
        </div>
      </div>
    </div>
  );
}

function RejectionBanner({ stage }: { stage?: string | null }) {
  if (!stage) return null;
  if (stage.includes("Regime")) return null;

  return (
    <div className="mb-3 p-3 bg-orange-900/20 border border-orange-700/30 rounded-lg">
      <div className="flex items-center gap-2">
        <span className="text-orange-400 text-lg">⚠</span>
        <div>
          <div className={`text-xs font-semibold ${getRejectionStageColor(stage)}`}>Trade rejected: {stage}</div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Dashboard ───

export default function Dashboard() {
  const [snapshots, setSnapshots] = useState<Record<string, MarketSnapshot>>({});

  const [loading, setLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<string>("");
  const [error, setError] = useState<string>("");

  const fetchSnapshots = useCallback(async () => {
    const snaps: Record<string, MarketSnapshot> = {};
    for (const pair of PAIRS) {
      try {
        const res = await fetch(`/api/signals?pair=${encodeURIComponent(pair)}&action=snapshot`);
        if (!res.ok) continue;
        const data = await res.json();
        if (data.snapshot) snaps[pair] = data.snapshot;
      } catch (e) {
        console.error(`Snapshot failed for ${pair}:`, e);
      }
    }
    setSnapshots(snaps);
    setLastUpdate(new Date().toLocaleTimeString());
  }, []);



  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      await fetchSnapshots();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [fetchSnapshots]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 60000);
    return () => clearInterval(interval);
  }, [refresh]);

  const triggerCron = async () => {
    setLoading(true);
    try {
      const secret = process.env.NEXT_PUBLIC_CRON_SECRET || "";
      const res = await fetch(`/api/cron?secret=${encodeURIComponent(secret)}`);
      const data = await res.json();
      console.log("Cron result:", data);
      await refresh();
    } catch (e) {
      setError(`Cron trigger failed: ${e}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-4 md:p-6">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
              CXSwitch <span className="text-blue-400">v29.1</span>
            </h1>
            <p className="text-gray-500 text-sm mt-1">Diagnostic Dashboard — Full Strategy Visibility</p>
          </div>
          <div className="flex items-center gap-2 md:gap-3">
            <span className="text-xs text-gray-500 hidden sm:inline">{lastUpdate || "—"}</span>
            <button
              onClick={refresh}
              disabled={loading}
              className="px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm font-medium transition"
            >
              {loading ? "..." : "Refresh"}
            </button>
            <button
              onClick={triggerCron}
              disabled={loading}
              className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm font-medium transition"
            >
              Run Cron
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-sm">
            {error}
          </div>
        )}

                {/* Market Snapshot Cards */}
        <section>
          <h2 className="text-lg font-semibold mb-4 text-gray-300">Market Snapshots</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
            {PAIRS.map(pair => {
              const snap = snapshots[pair];
              if (!snap) {
                return (
                  <div key={pair} className="p-4 bg-gray-900 rounded-xl border border-gray-800 animate-pulse">
                    <div className="h-5 bg-gray-800 rounded w-16 mb-3"></div>
                    <div className="h-8 bg-gray-800 rounded w-24 mb-3"></div>
                    <div className="h-4 bg-gray-800 rounded w-full"></div>
                  </div>
                );
              }

              const regime = snap.regime;
              const dirColor = getDirectionColor(regime?.direction);
              const strengthClass = getStrengthBadge(regime?.strength || "NEUTRAL");
              const adxLabel = getAdxLabel(snap.adx);
              const adxColor = getAdxColor(snap.adx);

              return (
                <div key={pair} className="p-4 bg-gray-900 rounded-xl border border-gray-800 hover:border-gray-700 transition">
                  {/* Pair header with strength badge */}
                  <div className="flex items-center justify-between mb-3">
                    <span className="font-mono font-bold text-sm">{pair}</span>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${strengthClass}`}>
                      {regime?.strength || "NEUTRAL"}
                    </span>
                  </div>

                  {/* Price and Direction */}
                  <div className="mb-3">
                    <div className="text-2xl font-mono font-bold">${snap.price?.toFixed(2) || "—"}</div>
                    <div className={`text-xs font-bold ${dirColor} mt-0.5`}>
                      {regime?.direction || "NEUTRAL"}
                    </div>
                  </div>

                  {/* No Signal Banner */}
                  <NoSignalBanner regime={regime} rejectionStage={snap.rejectionStage} />

                  {/* Rejection Banner (non-regime) */}
                  <RejectionBanner stage={snap.rejectionStage} />

                  {/* Regime Diagnostics */}
                  <RegimePanel regime={regime} />

                  {/* Entry Candidates */}
                  <EntryCandidatesPanel candidates={snap.entryCandidates} />

                  {/* Trend Context — 1H / 4H / 1D (actual values, not copied) */}
                  <div className="mb-3 p-2 bg-gray-800/50 rounded-lg">
                    <div className="text-[10px] text-gray-500 mb-1.5 uppercase tracking-wider">Trend Context</div>
                    <div className="grid grid-cols-3 gap-1 text-center">
                      <div>
                        <div className="text-[10px] text-gray-500">1H</div>
                        <div className={`text-xs font-bold ${getDirectionColor(snap.trend1h?.direction)}`}>{snap.trend1h?.direction || "—"}</div>
                        <div className="text-[10px] text-gray-600">{snap.trend1h?.strength || ""}</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-gray-500">4H</div>
                        <div className={`text-xs font-bold ${getDirectionColor(snap.trend4h?.direction)}`}>{snap.trend4h?.direction || "—"}</div>
                        <div className="text-[10px] text-gray-600">{snap.trend4h?.strength || ""}</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-gray-500">1D</div>
                        <div className={`text-xs font-bold ${getDirectionColor(snap.trend1d?.direction)}`}>{snap.trend1d?.direction || "—"}</div>
                        <div className="text-[10px] text-gray-600">{snap.trend1d?.strength || ""}</div>
                      </div>
                    </div>
                  </div>

                  {/* Metrics grid */}
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="p-2 bg-gray-800/50 rounded-lg">
                      <div className="text-gray-500 mb-0.5">ADX</div>
                      <div className="flex items-baseline gap-1">
                        <span className="font-mono font-semibold">{snap.adx?.toFixed(1) || "—"}</span>
                        <span className={`text-[10px] ${adxColor}`}>{adxLabel}</span>
                      </div>
                    </div>
                    <div className="p-2 bg-gray-800/50 rounded-lg">
                      <div className="text-gray-500 mb-0.5">RSI</div>
                      <div className="font-mono font-semibold">{snap.rsi?.toFixed(1) || "—"}</div>
                    </div>
                    <div className="p-2 bg-gray-800/50 rounded-lg">
                      <div className="text-gray-500 mb-0.5">Stoch K</div>
                      <div className="font-mono font-semibold">{snap.stochK?.toFixed(1) || "—"}</div>
                    </div>
                    <div className="p-2 bg-gray-800/50 rounded-lg">
                      <div className="text-gray-500 mb-0.5">Stoch D</div>
                      <div className="font-mono font-semibold">{snap.stochD?.toFixed(1) || "—"}</div>
                    </div>
                    <div className="p-2 bg-gray-800/50 rounded-lg">
                      <div className="text-gray-500 mb-0.5">Stoch 1H K</div>
                      <div className="font-mono font-semibold">{snap.stoch1hK?.toFixed(1) || "—"}</div>
                    </div>
                    <div className="p-2 bg-gray-800/50 rounded-lg">
                      <div className="text-gray-500 mb-0.5">Stoch 1H D</div>
                      <div className="font-mono font-semibold">{snap.stoch1hD?.toFixed(1) || "—"}</div>
                    </div>
                  </div>

                  {/* Strategy Debug Panel */}
                  <DebugPanel debug={snap.debug} pair={pair} />
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}
