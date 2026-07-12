function dirColor(dir: string | null | undefined): string {
  if (!dir) return "text-gray-400";
  const d = String(dir).toUpperCase();
  if (d === "LONG" || d === "BULLISH") return "text-green-400";
  if (d === "SHORT" || d === "BEARISH") return "text-red-400";
  return "text-gray-400";
}

function strengthBadge(strength: string): string {
  const s = (strength || "").toUpperCase();
  if (s === "STRONG") return "bg-green-500/20 text-green-400 border-green-500/30";
  if (s === "MEDIUM" || s === "MODERATE") return "bg-yellow-500/20 text-yellow-400 border-yellow-500/30";
  if (s === "ACTIVE") return "bg-blue-500/20 text-blue-400 border-blue-500/30";
  return "bg-gray-700/50 text-gray-400 border-gray-600/30";
}

function phaseColor(phase: string | undefined): string {
  if (phase === "EXHAUSTION") return "text-red-400";
  if (phase === "EXPANSION") return "text-amber-400";
  if (phase === "BUILDING") return "text-blue-400";
  return "text-gray-400";
}

function phaseBg(phase: string | undefined): string {
  if (phase === "EXHAUSTION") return "bg-red-500/15 border-red-500/30";
  if (phase === "EXPANSION") return "bg-amber-500/15 border-amber-500/30";
  if (phase === "BUILDING") return "bg-blue-500/15 border-blue-500/30";
  return "bg-gray-800/50";
}

function phaseLabel(phase: string | undefined, dir: string | null): string {
  if (!phase || !dir) return "Building";
  if (phase === "EXPANSION") return "Expanding";
  if (phase === "EXHAUSTION") return "Exhaustion";
  return "Building";
}

function tradePhaseColor(phase: string | undefined): string {
  if (phase === "ENTRY") return "text-yellow-400";
  if (phase === "BUILDING") return "text-blue-400";
  if (phase === "TREND") return "text-green-400";
  if (phase === "PROFIT_PROTECTION") return "text-emerald-400";
  if (phase === "EXIT") return "text-red-400";
  return "text-gray-400";
}

function tradePhaseBg(phase: string | undefined): string {
  if (phase === "ENTRY") return "bg-yellow-500/15 border-yellow-500/30";
  if (phase === "BUILDING") return "bg-blue-500/15 border-blue-500/30";
  if (phase === "TREND") return "bg-green-500/15 border-green-500/30";
  if (phase === "PROFIT_PROTECTION") return "bg-emerald-500/15 border-emerald-500/30";
  if (phase === "EXIT") return "bg-red-500/15 border-red-500/30";
  return "bg-gray-800/50";
}

function rColor(r: string | undefined): string {
  if (!r) return "text-gray-400";
  const val = parseFloat(r);
  if (val >= 2) return "text-emerald-400";
  if (val >= 1) return "text-green-400";
  if (val >= 0) return "text-blue-400";
  return "text-red-400";
}

function readinessColor(pct: number): string {
  if (pct >= 80) return "text-green-400";
  if (pct >= 50) return "text-amber-400";
  return "text-gray-400";
}

function readinessBarColor(pct: number): string {
  if (pct >= 80) return "bg-green-500";
  if (pct >= 50) return "bg-amber-500";
  return "bg-gray-600";
}

function statusBadge(snap: MarketSnapshot): { label: string; className: string } {
  if (snap.activeTrade) {
    return { label: "ACTIVE", className: "bg-blue-500/20 text-blue-400 border-blue-500/30" };
  }
  if (snap.signal) {
    return snap.signal.scale === "ADD"
      ? { label: "SNIPER", className: "bg-red-500/20 text-red-400 border-red-500/30" }
      : { label: "BUILDING", className: "bg-amber-500/20 text-amber-400 border-amber-500/30" };
  }
  if ((snap.readiness || 0) >= 60) {
    return { label: "BUILDING", className: "bg-amber-500/20 text-amber-400 border-amber-500/30" };
  }
  return { label: "WATCH", className: "bg-gray-700/50 text-gray-400 border-gray-600/30" };
}

// ═══════════════════════════════════════════════════════════
// FIX: Helper to determine blocker color based on type
// ═══════════════════════════════════════════════════════════
function blockerColor(block: string): string {
  if (block.includes("R:R")) return "text-amber-300";
  if (block.includes("conf=") || block.includes("confidence")) return "text-yellow-300";
  if (block.includes("Hysteresis")) return "text-orange-300";
  if (block.includes("Cooldown")) return "text-blue-300";
  if (block.includes("Churn")) return "text-purple-300";
  return "text-red-300";
}

function blockerDotColor(block: string): string {
  if (block.includes("R:R")) return "text-amber-500";
  if (block.includes("conf=") || block.includes("confidence")) return "text-yellow-500";
  if (block.includes("Hysteresis")) return "text-orange-500";
  if (block.includes("Cooldown")) return "text-blue-500";
  if (block.includes("Churn")) return "text-purple-500";
  return "text-red-500";
}

function MarketCard({ snap }: { snap: MarketSnapshot }) {
  const badge = statusBadge(snap);
  const regimeDir = snap.regime?.direction;
  const summary = snap.summary;

  return (
    <div className="p-5 bg-gray-900 rounded-xl border border-gray-800 hover:border-gray-600 transition shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <span className="font-mono font-bold text-xl tracking-tight">{snap.pair.replace("/USD", "")}</span>
        <span className={`text-xs font-bold px-3 py-1 rounded-lg border ${badge.className} uppercase tracking-wider`}>
          {badge.label}
        </span>
      </div>

      {/* Price */}
      <div className="mb-4">
        <div className="text-sm text-gray-500">Price: <span className="text-gray-200 font-mono">${snap.price?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
      </div>

      {/* 4H Trend + 15M Structure */}
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <div className="text-xs uppercase text-gray-500 font-semibold tracking-wider mb-1">4H Trend</div>
          <div className={`text-sm font-bold ${dirColor(snap.trend4h?.direction)}`}>
            {snap.trend4h?.direction === "LONG" ? "Bullish" : snap.trend4h?.direction === "SHORT" ? "Bearish" : "Neutral"}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase text-gray-500 font-semibold tracking-wider mb-1">15M Structure</div>
          <div className="text-sm font-bold text-gray-200">{snap.structure15m || "Neutral"}</div>
        </div>
      </div>

      {/* Macro Bias */}
      <div className="mb-4">
        <div className="text-xs uppercase text-gray-500 font-semibold tracking-wider mb-1">Macro Bias</div>
        <div className={`text-sm font-bold ${dirColor(snap.trend1d?.direction)}`}>
          {snap.trend1d?.direction === "LONG" ? "Bullish" : snap.trend1d?.direction === "SHORT" ? "Bearish" : "Neutral"}
          {snap.trend1d?.strength ? ` (${snap.trend1d.strength.toLowerCase()})` : ""}
        </div>
      </div>

      {/* Phase Banner */}
      <div className={`mb-4 p-3 rounded-lg border ${phaseBg(snap.phase4h)}`}>
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase text-gray-500 font-semibold tracking-wider">Phase</span>
          <span className={`text-sm font-bold ${phaseColor(snap.phase4h)}`}>
            {phaseLabel(snap.phase4h, regimeDir)}
          </span>
        </div>
        <div className="text-xs text-gray-500 mt-1">
          4H Stoch: {snap.stochK?.toFixed(1)} / {snap.stochD?.toFixed(1)}
          {snap.phase4h === "EXPANSION" ? " — momentum running, dont chase" : snap.phase4h === "EXHAUSTION" ? " — reversal zone, watch for entry" : " — waiting for setup"}
        </div>
      </div>

      {/* Readiness Bar */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs uppercase text-gray-500 font-semibold tracking-wider">Readiness</span>
          <span className={`text-sm font-bold ${readinessColor(snap.readiness || 0)}`}>{snap.readiness || 0}%</span>
        </div>
        <div className="w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full ${readinessBarColor(snap.readiness || 0)} transition-all duration-500`}
            style={{ width: `${Math.min(snap.readiness || 0, 100)}%` }}
          />
        </div>
      </div>

      {/* Trade Setup (when signal exists) */}
      {snap.signal && (
        <div className="mb-4 p-4 bg-gray-800/50 rounded-lg border border-gray-700/50">
          <div className="text-xs uppercase text-gray-500 font-semibold tracking-wider mb-3">Trade Setup</div>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-sm text-gray-400">Direction:</span>
              <span className={`text-sm font-bold ${dirColor(snap.signal.direction)}`}>{snap.signal.direction}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-gray-400">Entry:</span>
              <span className="text-sm font-mono font-bold text-gray-200">${snap.signal.entry.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-gray-400">SL:</span>
              <span className="text-sm font-mono font-bold text-red-400">${snap.signal.stop.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-gray-400">TP:</span>
              <span className="text-sm font-mono font-bold text-green-400">${snap.signal.target.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-gray-400">RR:</span>
              <span className="text-sm font-mono font-bold text-gray-200">{snap.signal.rr.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-gray-400">Confidence:</span>
              <span className={`text-sm font-bold ${snap.signal.confidence >= 70 ? "text-green-400" : "text-amber-400"}`}>{snap.signal.confidence}%</span>
            </div>
          </div>
        </div>
      )}

      {/* Active Trade */}
      {snap.activeTrade && (
        <div className="mb-4 p-4 bg-blue-500/10 border border-blue-500/30 rounded-lg">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs uppercase text-blue-400 font-bold tracking-wider">Active Trade</span>
            <span className={`text-lg font-mono font-bold ${snap.activeTrade.pnl.startsWith("-") ? "text-red-400" : "text-green-400"}`}>
              {snap.activeTrade.pnl}
            </span>
          </div>

          {/* Phase + R Badge */}
          <div className="flex items-center gap-2 mb-3">
            <div className={`px-2 py-1 rounded border ${tradePhaseBg(snap.activeTrade.phase)}`}>
              <span className={`text-xs font-bold uppercase tracking-wider ${tradePhaseColor(snap.activeTrade.phase)}`}>
                {snap.activeTrade.phase || "UNKNOWN"}
              </span>
            </div>
            {snap.activeTrade.currentR && (
              <div className="px-2 py-1 rounded bg-gray-800 border border-gray-700">
                <span className={`text-xs font-mono font-bold ${rColor(snap.activeTrade.currentR)}`}>
                  R: {snap.activeTrade.currentR}
                </span>
              </div>
            )}
            {snap.activeTrade.entryMode && (
              <div className="px-2 py-1 rounded bg-gray-800 border border-gray-700">
                <span className="text-xs text-gray-400">{snap.activeTrade.entryMode}</span>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2 text-sm">
            <div><span className="text-gray-500">Entry:</span> <span className="font-mono text-gray-200">${snap.activeTrade.entry.toFixed(2)}</span></div>
            <div><span className="text-gray-500">Stop:</span> <span className="font-mono text-red-400">${snap.activeTrade.stop.toFixed(2)}</span></div>
            <div><span className="text-gray-500">Target:</span> <span className="font-mono text-green-400">${snap.activeTrade.target.toFixed(2)}</span></div>
            <div><span className="text-gray-500">Size:</span> <span className="font-bold text-blue-400">{snap.activeTrade.positionSizePct ? (snap.activeTrade.positionSizePct * 100).toFixed(0) + "%" : "—"}</span></div>
          </div>

          {snap.activeTrade.lockedStop !== undefined && snap.activeTrade.lockedStop !== null && (
            <div className="mt-2 p-2 bg-emerald-500/10 border border-emerald-500/20 rounded text-xs">
              <span className="text-emerald-400">Profit Lock L{snap.activeTrade.profitLockLevel || 1}:</span> <span className="font-mono text-emerald-300">${snap.activeTrade.lockedStop.toFixed(2)}</span>
            </div>
          )}

          {(snap.activeTrade.maxProfit || snap.activeTrade.maxDrawdown) && (
            <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
              <div><span className="text-gray-500">Max Profit:</span> <span className="text-green-400">{snap.activeTrade.maxProfit}</span></div>
              <div><span className="text-gray-500">Max DD:</span> <span className="text-red-400">{snap.activeTrade.maxDrawdown}</span></div>
            </div>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════
          FIX: Summary with correct blocker priority + color coding
          ═══════════════════════════════════════════════════════════ */}
      {!snap.signal && !snap.activeTrade && summary && (
        <div className="mb-4">
          {/* Status */}
          <div className={`mb-2 p-3 rounded-lg border ${summary.status === "READY" ? "bg-green-500/10 border-green-500/30" : summary.status === "BUILDING" ? "bg-amber-500/10 border-amber-500/30" : "bg-gray-800/50 border-gray-700/30"}`}>
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase text-gray-500 font-semibold tracking-wider">Status</span>
              <span className={`text-sm font-bold ${summary.status === "READY" ? "text-green-400" : summary.status === "BUILDING" ? "text-amber-400" : "text-gray-400"}`}>
                {summary.status}
              </span>
            </div>
          </div>

          {/* Next Trigger / Distance */}
          {summary.nextTrigger && (
            <div className="mb-2 p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg">
              <div className="text-xs uppercase text-blue-500 font-semibold tracking-wider mb-1">Next Trigger</div>
              <div className="text-sm text-blue-300">{summary.nextTrigger}</div>
              {summary.distanceToEntry !== undefined && summary.distanceToEntry !== null && (
                <div className="text-xs text-blue-500/70 mt-1">
                  Distance: {typeof summary.distanceToEntry === "number" ? summary.distanceToEntry.toFixed(2) : summary.distanceToEntry}%
                </div>
              )}
            </div>
          )}

          {/* Blockers — color-coded by type */}
          {summary.blocks && summary.blocks.length > 0 && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
              <div className="text-xs uppercase text-red-400 font-semibold tracking-wider mb-2">Blockers</div>
              <div className="space-y-1">
                {summary.blocks.map((block, i) => (
                  <div key={i} className={`text-xs flex items-start gap-2 ${blockerColor(block)}`}>
                    <span className={`mt-0.5 ${blockerDotColor(block)}`}>●</span>
                    {block}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Full Debug */}
          {summary.debug && summary.debug.length > 0 && (
            <details className="mt-2">
              <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-400">Show full debug</summary>
              <div className="mt-2 p-2 bg-gray-800/30 rounded text-xs text-gray-500 space-y-1">
                {summary.debug.map((d, i) => (
                  <div key={i}>{d}</div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="text-xs text-gray-600 text-right">
        Updated: {new Date(snap.timestamp).toLocaleString()}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [snapshots, setSnapshots] = useState<Record<string, MarketSnapshot>>({});
  const [loading, setLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<string>("");
  const [error, setError] = useState<string>("");

  const fetchSnapshots = useCallback(async () => {
    try {
      const res = await fetch("/api/signals");
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.error || `HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      const marketMap: Record<string, MarketSnapshot> = {};
      const markets = data.markets || data.snapshot?.markets || [];
      for (const m of markets) {
        if (m.pair) marketMap[m.pair] = m;
      }
      setSnapshots(marketMap);
      setLastUpdate(new Date(data.lastCronRun || Date.now()).toLocaleString());
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try { await fetchSnapshots(); } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
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
      await fetch(`/api/cron?secret=${encodeURIComponent(secret)}`);
      await refresh();
    } catch (e) {
      setError(`Cron failed: ${e}`);
    } finally {
      setLoading(false);
    }
  };

  const activeTrades = Object.values(snapshots).filter(s => s.activeTrade).length;

  // v35.2: Count trades by phase for funnel visibility
  const phaseCounts = Object.values(snapshots).reduce((acc, s) => {
    if (s.activeTrade?.phase) {
      acc[s.activeTrade.phase] = (acc[s.activeTrade.phase] || 0) + 1;
    }
    return acc;
  }, {} as Record<string, number>);

  return (
    <main className="min-h-screen bg-black text-gray-100 p-4 md:p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">CXSwitch v35.2</h1>
            <p className="text-gray-500 text-sm mt-1">
              Last updated: {lastUpdate || "—"} | Active: {activeTrades}
              {Object.entries(phaseCounts).map(([phase, count]) => (
                <span key={phase} className="ml-2 text-xs text-gray-600">
                  {phase}: {count}
                </span>
              ))}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={refresh}
              disabled={loading}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 rounded-lg text-sm font-medium transition border border-gray-700"
            >
              {loading ? "..." : "Refresh"}
            </button>
            <button
              onClick={triggerCron}
              disabled={loading}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 rounded-lg text-sm font-medium transition border border-gray-700"
            >
              {loading ? "Running..." : "Run Cron"}
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-sm">
            {error}
          </div>
        )}

        {/* 2x2 Grid */}
        <section>
          <h2 className="text-lg font-semibold mb-4 text-gray-300">Market Overview</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {PAIRS.map(pair => {
              const snap = snapshots[pair];
              if (!snap) {
                return (
                  <div key={pair} className="p-5 bg-gray-900 rounded-xl border border-gray-800 animate-pulse">
                    <div className="h-6 bg-gray-800 rounded w-16 mb-4"></div>
                    <div className="h-4 bg-gray-800 rounded w-32 mb-4"></div>
                    <div className="h-20 bg-gray-800 rounded w-full mb-4"></div>
                    <div className="h-2 bg-gray-800 rounded w-full"></div>
                  </div>
                );
              }
              return <MarketCard key={pair} snap={snap} />;
            })}
          </div>
        </section>

        {/* Footer */}
        <div className="mt-8 pt-4 border-t border-gray-800 text-center">
          <p className="text-xs text-gray-600">
            CXSwitch v35.2 — R-Based Lifecycle | ENTRY → BUILDING (1R) → TREND (2R) → PROFIT_PROTECTION
          </p>
        </div>
      </div>
    </main>
  );
}
