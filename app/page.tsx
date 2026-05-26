"use client";

import { useState, useEffect } from "react";
import type { SignalViewModel } from "@/lib/signal-view-model";

export default function Dashboard() {
  const [signals, setSignals] = useState<SignalViewModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSignals = async () => {
    try {
      setError(null);
      const res = await fetch("/api/signals", { cache: "no-store" });
      
      if (!res.ok) {
        throw new Error(`API returned ${res.status}`);
      }

      const json = await res.json();
      setSignals(Array.isArray(json) ? json : []);
    } catch (err) {
      console.error("[FETCH] Error:", err);
      setError(String(err));
    }
  };

  const triggerCron = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/cron", { method: "POST" });
      if (!res.ok) throw new Error("Cron failed");
      
      await new Promise(r => setTimeout(r, 500));
      await fetchSignals();
    } catch (err) {
      setError("Cron error: " + String(err));
      console.error("[CRON] Error:", err);
    } finally {
      setLoading(false);
    }
  };

  const testTelegram = async () => {
    try {
      const res = await fetch("/api/test-telegram", { method: "POST" });
      const result = await res.json();
      alert(result.ok ? "Telegram alert sent!" : "Telegram failed: " + (result.error || "Unknown error"));
    } catch (err) {
      alert("Telegram error: " + String(err));
    }
  };

  useEffect(() => {
    fetchSignals();
    const id = setInterval(fetchSignals, 15000);
    return () => clearInterval(id);
  }, []);

  const globalReadiness = signals.length > 0
    ? Math.round(
        signals.reduce((sum, s) => {
          const score = typeof s.readiness_score === "number" ? s.readiness_score : 0;
          return sum + Math.max(0, Math.min(100, score)); // Clamp to 0-100
        }, 0) / signals.length
      )
    : 0;

  const getReadinessLabel = (score: number) => {
    const safeScore = typeof score === "number" && !isNaN(score) ? score : 0;
    if (safeScore < 30) return "No setup forming";
    if (safeScore < 60) return "Watching breakout structure";
    if (safeScore < 85) return "Approaching sniper condition";
    return "High probability execution zone";
  };

  const getReadinessColor = (score: number) => {
    const safeScore = typeof score === "number" && !isNaN(score) ? score : 0;
    if (safeScore < 30) return "#555";
    if (safeScore < 60) return "#ff9100";
    if (safeScore < 85) return "#00d4ff";
    return "#00c853";
  };

  return (
    <div style={{ backgroundColor: "#000", color: "#e5e7eb", minHeight: "100vh", padding: "24px", fontFamily: "system-ui, sans-serif" }}>
      {/* HEADER */}
      <div style={{ marginBottom: "32px", borderBottom: "1px solid #2a2a2a", paddingBottom: "20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <div>
            <p style={{ margin: "0 0 8px 0", fontSize: "32px", fontWeight: "bold", color: "#fff" }}>Trading Signals</p>
            <p style={{ margin: 0, color: "#9ca3af", fontSize: "13px" }} suppressHydrationWarning>
              Last updated: {new Date().toLocaleString()}
            </p>
            {error && (
              <p style={{ margin: "8px 0 0 0", color: "#ff6b6b", fontSize: "12px" }}>
                ⚠️ {error}
              </p>
            )}
          </div>
          <div style={{ display: "flex", gap: "12px" }}>
            <button
              onClick={triggerCron}
              disabled={loading}
              style={{
                padding: "8px 16px",
                backgroundColor: "#222",
                color: "#fff",
                border: "1px solid #2a2a2a",
                borderRadius: "6px",
                cursor: loading ? "not-allowed" : "pointer",
                opacity: loading ? 0.5 : 1,
                fontSize: "14px",
                fontWeight: "500",
              }}
            >
              {loading ? "Refreshing..." : "Refresh"}
            </button>
            <button
              onClick={testTelegram}
              style={{
                padding: "8px 16px",
                backgroundColor: "#222",
                color: "#fff",
                border: "1px solid #2a2a2a",
                borderRadius: "6px",
                cursor: "pointer",
                fontSize: "14px",
                fontWeight: "500",
              }}
            >
              Test Alert
            </button>
          </div>
        </div>

        {/* TRADE READINESS METER (GLOBAL) */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
            <span style={{ fontSize: "13px", fontWeight: "600", color: "#fff" }}>Trade Readiness</span>
            <span style={{ fontSize: "14px", fontWeight: "bold", color: getReadinessColor(globalReadiness) }}>
              {globalReadiness}%
            </span>
          </div>
          <div style={{ width: "100%", height: "8px", backgroundColor: "#111", borderRadius: "4px", overflow: "hidden", marginBottom: "8px" }}>
            <div
              style={{
                width: `${globalReadiness}%`,
                height: "100%",
                backgroundColor: getReadinessColor(globalReadiness),
                transition: "width 0.3s ease",
              }}
            />
          </div>
          <p style={{ margin: "6px 0 0 0", fontSize: "12px", color: "#9ca3af" }}>
            {getReadinessLabel(globalReadiness)}
          </p>
        </div>
      </div>

      {/* SYMBOL CARDS */}
      <div style={{ marginBottom: "32px" }}>
        <h2 style={{ marginBottom: "16px", fontSize: "18px", fontWeight: "600", color: "#fff" }}>Market Overview</h2>
        {signals.length === 0 ? (
          <p style={{ color: "#9ca3af" }}>Waiting for market data...</p>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "16px" }}>
            {signals.map((signal) => {
              const safeReadiness = typeof signal.readiness_score === "number" && !isNaN(signal.readiness_score)
                ? Math.max(0, Math.min(100, signal.readiness_score))
                : 0;
              const isSNIPER = signal.state === "SNIPER";
              const isBuilding = signal.state === "BUILDING";
              const borderColor = isSNIPER 
                ? (signal.trade?.direction === "LONG" ? "#00c853" : "#ff1744") 
                : isBuilding ? "#ff9100" : "#555";

              return (
                <div
                  key={signal.symbol}
                  style={{
                    backgroundColor: "#111",
                    border: "1px solid #2a2a2a",
                    borderLeft: `4px solid ${borderColor}`,
                    borderRadius: "8px",
                    padding: "16px",
                  }}
                >
                  {/* HEADER */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", marginBottom: "16px" }}>
                    <div>
                      <h3 style={{ margin: "0 0 8px 0", fontSize: "20px", fontWeight: "bold", color: "#fff" }}>{signal.symbol}</h3>
                      <p style={{ margin: 0, fontSize: "12px", color: "#9ca3af" }}>
                        Price: ${signal.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </p>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div
                        style={{
                          padding: "6px 12px",
                          backgroundColor: borderColor,
                          color: "#000",
                          borderRadius: "4px",
                          fontSize: "12px",
                          fontWeight: "bold",
                          marginBottom: "6px",
                        }}
                      >
                        {signal.state}
                      </div>
                      <p style={{ margin: 0, fontSize: "11px", color: "#9ca3af", lineHeight: "1.4", maxWidth: "140px" }}>
                        {signal.reason || "No trade context"}
                      </p>
                    </div>
                  </div>

                  {/* MARKET STRUCTURE (ALWAYS SHOWN) */}
                  <div style={{ fontSize: "12px", lineHeight: "1.6", color: "#e5e7eb", marginBottom: "12px", paddingBottom: "12px", borderBottom: "1px solid #2a2a2a" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                      <div>
                        <div style={{ color: "#9ca3af", fontSize: "10px", fontWeight: "600", marginBottom: "4px" }}>4H TREND</div>
                        <div style={{ fontWeight: "500", color: "#fff" }}>{signal.trend_4h}</div>
                      </div>
                      <div>
                        <div style={{ color: "#9ca3af", fontSize: "10px", fontWeight: "600", marginBottom: "4px" }}>15M STRUCTURE</div>
                        <div style={{ fontWeight: "500", color: "#fff" }}>{signal.structure_15m}</div>
                      </div>
                    </div>
                    <div style={{ marginTop: "8px" }}>
                      <div style={{ color: "#9ca3af", fontSize: "10px", fontWeight: "600", marginBottom: "4px" }}>MACRO BIAS</div>
                      <div style={{ fontWeight: "500", color: "#fff" }}>{signal.macro_bias}</div>
                    </div>
                  </div>

                  {/* READINESS SCORE (ALWAYS SHOWN - DEFENSIVE) */}
                  <div style={{ fontSize: "12px", marginBottom: "12px", paddingBottom: "12px", borderBottom: "1px solid #2a2a2a" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                      <span style={{ color: "#9ca3af", fontSize: "10px", fontWeight: "600" }}>READINESS</span>
                      <span style={{ fontWeight: "bold", color: getReadinessColor(safeReadiness) }}>
                        {safeReadiness}%
                      </span>
                    </div>
                    <div style={{ width: "100%", height: "6px", backgroundColor: "#0a0a0a", borderRadius: "3px", overflow: "hidden" }}>
                      <div
                        style={{
                          width: `${safeReadiness}%`,
                          height: "100%",
                          backgroundColor: getReadinessColor(safeReadiness),
                        }}
                      />
                    </div>
                  </div>

                  {/* STATE CONTEXT BLOCK (ALWAYS SHOWN - EXPLAINS EVERY STATE) */}
                  <div style={{ fontSize: "12px", lineHeight: "1.8", color: "#e5e7eb", marginBottom: "12px", paddingBottom: "12px", borderBottom: "1px solid #2a2a2a" }}>
                    {isSNIPER && (
                      <>
                        <div style={{ color: "#00c853", fontSize: "11px", fontWeight: "600", marginBottom: "4px" }}>HIGH PROBABILITY SETUP</div>
                        <p style={{ margin: "0 0 6px 0", fontSize: "11px", color: "#9ca3af" }}>
                          Confluence metrics align. Entry conditions triggered. Executing trade with defined risk/reward ratio.
                        </p>
                      </>
                    )}
                    {isBuilding && (
                      <>
                        <div style={{ color: "#ff9100", fontSize: "11px", fontWeight: "600", marginBottom: "4px" }}>EARLY SETUP FORMING</div>
                        <p style={{ margin: "0 0 6px 0", fontSize: "11px", color: "#9ca3af" }}>
                          {typeof signal.momentum_percent === "number" && signal.momentum_percent > 0.5 
                            ? "Momentum developing. Waiting for structure confirmation."
                            : signal.trend_4h !== "Neutral"
                            ? `${signal.trend_4h} trend alignment developing. Structure not yet confirmed.`
                            : "Setup building. Multiple confluence factors tracking."}
                        </p>

                        {/* TRIGGER CONDITIONS - Shows exactly which conditions triggered BUILDING */}
                        <div style={{ margin: "8px 0", fontSize: "10px", color: "#9ca3af", lineHeight: "1.6" }}>
                          <div style={{ fontWeight: "600", marginBottom: "4px", color: "#fff" }}>TRIGGER CONDITIONS</div>
                          
                          {/* Condition A: Structure != Range */}
                          {(() => {
                            const isActive = signal.structure_15m !== "Range";
                            return (
                              <div style={{ opacity: isActive ? 1 : 0.5, color: isActive ? "#9ca3af" : "#555" }}>
                                {isActive ? "✔" : "✖"} Structure: {signal.structure_15m}
                              </div>
                            );
                          })()}

                          {/* Condition B: Momentum >= 0.15% */}
                          {(() => {
                            const mom = typeof signal.momentum_percent === "number" ? signal.momentum_percent : 0;
                            const isActive = mom >= 0.15;
                            return (
                              <div style={{ opacity: isActive ? 1 : 0.5, color: isActive ? "#9ca3af" : "#555" }}>
                                {isActive ? "✔" : "✖"} Momentum: {mom.toFixed(3)}% (threshold ≥ 0.15%)
                              </div>
                            );
                          })()}

                          {/* Condition C: Volatility >= 0.25% */}
                          {(() => {
                            const vol = typeof signal.volatility_percent === "number" ? signal.volatility_percent : 0;
                            const isActive = vol >= 0.25;
                            return (
                              <div style={{ opacity: isActive ? 1 : 0.5, color: isActive ? "#9ca3af" : "#555" }}>
                                {isActive ? "✔" : "✖"} Volatility: {vol.toFixed(3)}% (threshold ≥ 0.25%)
                              </div>
                            );
                          })()}

                          {/* Condition D: Trend != Neutral AND Momentum > 0.2% */}
                          {(() => {
                            const mom = typeof signal.momentum_percent === "number" ? signal.momentum_percent : 0;
                            const isActive = signal.trend_4h !== "Neutral" && mom > 0.2;
                            return (
                              <div style={{ opacity: isActive ? 1 : 0.5, color: isActive ? "#9ca3af" : "#555" }}>
                                {isActive ? "✔" : "✖"} Trend: {signal.trend_4h} {mom > 0.2 ? "+ momentum" : "(insufficient momentum)"}
                              </div>
                            );
                          })()}
                        </div>
                      </>
                    )}
                    {signal.state === "DO_NOT_TRADE" && (
                      <>
                        <div style={{ color: "#555", fontSize: "11px", fontWeight: "600", marginBottom: "4px" }}>MARKET MONITORING</div>
                        <p style={{ margin: "0 0 6px 0", fontSize: "11px", color: "#9ca3af" }}>
                          {signal.structure_15m === "Range" && typeof signal.volatility_percent === "number" && signal.volatility_percent < 0.5
                            ? "Market in consolidation phase. Low volatility. Waiting for breakout structure."
                            : signal.macro_bias === "Neutral"
                            ? "Macro bias neutral. Trend direction unclear. Observing market development."
                            : `Confluence low. Market context: ${signal.structure_15m.toLowerCase()} structure with ${typeof signal.momentum_percent === "number" ? signal.momentum_percent.toFixed(1) : "0.0"}% momentum.`}
                        </p>
                      </>
                    )}
                  </div>
                  {signal.direction ? (
                    <div style={{ fontSize: "12px", lineHeight: "1.6", color: "#e5e7eb" }}>
                      <div style={{ color: "#9ca3af", fontSize: "10px", fontWeight: "600", marginBottom: "8px" }}>TRADE SETUP</div>
                      <div style={{ marginBottom: "6px" }}>
                        <span style={{ color: "#9ca3af" }}>Direction:</span>{" "}
                        <span style={{ color: borderColor, fontWeight: "bold" }}>{signal.direction}</span>
                      </div>
                      <div style={{ marginBottom: "6px" }}>
                        <span style={{ color: "#9ca3af" }}>Entry:</span> <span style={{ fontWeight: "bold" }}>${signal.entry?.toFixed(2)}</span>
                      </div>
                      <div style={{ marginBottom: "6px" }}>
                        <span style={{ color: "#9ca3af" }}>SL:</span> <span style={{ fontWeight: "bold" }}>${signal.stopLoss?.toFixed(2)}</span>
                      </div>
                      <div style={{ marginBottom: "6px" }}>
                        <span style={{ color: "#9ca3af" }}>TP:</span> <span style={{ fontWeight: "bold" }}>${signal.takeProfit?.toFixed(2)}</span>
                      </div>
                      <div style={{ marginBottom: "6px" }}>
                        <span style={{ color: "#9ca3af" }}>RR:</span> <span style={{ fontWeight: "bold" }}>{signal.riskReward?.toFixed(2)}</span>
                      </div>
                      <div style={{ marginBottom: "6px" }}>
                        <span style={{ color: "#9ca3af" }}>Confidence:</span>{" "}
                        <span style={{ fontWeight: "bold", color: borderColor }}>{signal.confidence}%</span>
                      </div>
                      <div>
                        <span style={{ color: "#9ca3af" }}>Reason:</span> <span style={{ fontWeight: "500" }}>{signal.reason}</span>
                      </div>
                    </div>
                  ) : null}

                  {/* FOOTER */}
                  <div style={{ marginTop: "12px", paddingTop: "12px", borderTop: "1px solid #2a2a2a", fontSize: "11px", color: "#6b7280", textAlign: "right" }} suppressHydrationWarning>
                    Updated: {new Date(signal.updated_at).toLocaleString()}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
