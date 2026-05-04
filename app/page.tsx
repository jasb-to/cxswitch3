"use client";

import useSWR from "swr";
import { useState, useRef } from "react";
import { SignalCard } from "@/components/signal-card";
import { cn } from "@/lib/utils";
import type { SymbolSnapshot } from "@/lib/strategy";

const APP_VERSION = "1.0.0";
const SYMBOLS = ["BTC", "ETH", "SOL"];

const fetcher = (url: string) =>
  fetch(url, { cache: "no-store" }).then((r) => r.json());

interface ScanResponse {
  snapshots: SymbolSnapshot[];
  version: string;
  scannedAt: number;
}

function formatTime(ts: number | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function DashboardPage() {
  const [telegramStatus, setTelegramStatus] = useState<
    "idle" | "sending" | "ok" | "error"
  >("idle");
  const [telegramMsg, setTelegramMsg] = useState<string>("");
  const [scanning, setScanning] = useState(false);
  const prevDataRef = useRef<ScanResponse | undefined>(undefined);

  const { data, error, mutate } = useSWR<ScanResponse>(
    "/api/scan",
    fetcher,
    {
      refreshInterval: 60_000,
      // Keep stale data visible while revalidating to prevent flicker
      keepPreviousData: true,
      onSuccess: (d) => { prevDataRef.current = d; },
    }
  );

  // Prefer fresh data, fall back to previous to avoid blank flash
  const displayData = data ?? prevDataRef.current;
  const snapshots: SymbolSnapshot[] = displayData?.snapshots ?? [];

  // Build placeholder snapshots for initial load
  const displaySnapshots =
    snapshots.length > 0
      ? snapshots
      : SYMBOLS.map((symbol) => ({
          symbol,
          price: 0,
          breakout: "NONE" as const,
          checklist: [],
          signal: null,
          scannedAt: 0,
        }));

  const activeSignalCount = snapshots.filter((s) => s.signal && s.signal.state !== "END").length;
  const hasTelegram = true; // we don't know client-side; server will validate

  const handleTestTelegram = async () => {
    setTelegramStatus("sending");
    setTelegramMsg("");
    try {
      const res = await fetch("/api/test-telegram", { method: "POST" });
      const json = await res.json();
      if (json.ok) {
        setTelegramStatus("ok");
        setTelegramMsg("Message sent successfully");
      } else {
        setTelegramStatus("error");
        setTelegramMsg(json.error ?? "Unknown error");
      }
    } catch (e) {
      setTelegramStatus("error");
      setTelegramMsg("Network error");
    }
    setTimeout(() => setTelegramStatus("idle"), 4000);
  };

  const handleRefresh = async () => {
    if (scanning) return;
    setScanning(true);
    try {
      // Trigger the cron to update signals, then refresh scan data
      await fetch("/api/cron");
      await mutate();
    } finally {
      setScanning(false);
    }
  };

  return (
    <main className="min-h-screen bg-background text-foreground font-mono">
      {/* Top bar */}
      <header className="border-b border-border px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-[11px] tracking-widest text-muted-foreground uppercase">
            Multi-Timeframe Crypto Signal Analyzer
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span className="text-[11px] tracking-widest text-muted-foreground uppercase">
            Real-Time Intelligence
          </span>
        </div>
        <span className="text-[10px] text-muted-foreground/50 tracking-widest">
          v{APP_VERSION}
        </span>
      </header>

      <div className="px-6 py-5 max-w-[1400px] mx-auto flex flex-col gap-6">
        {/* Status row */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* System Status */}
          <div className="md:col-span-2 border border-border rounded-sm bg-card p-5 flex flex-col gap-4">
            <p className="text-[10px] tracking-widest text-muted-foreground uppercase">
              System Status
            </p>
            <div className="flex flex-col gap-3">
              <StatusRow
                label="Terminal"
                value="LIVE"
                dot
                dotColor="var(--signal-confirmed)"
                valueColor="text-[var(--signal-confirmed)]"
              />
              <StatusRow
                label="Telegram Bot"
                value="ACTIVE"
                dot
                dotColor={telegramStatus === "error" ? "var(--short-color)" : "var(--signal-end)"}
                valueColor={telegramStatus === "error" ? "text-[var(--short-color)]" : "text-[var(--signal-end)]"}
              />
              <StatusRow
                label="Last Update"
                value={formatTime(displayData?.scannedAt)}
                valueColor="text-foreground"
              />
            </div>

            {/* Test Telegram button */}
            <div className="flex flex-col gap-1.5 mt-1">
              <button
                onClick={handleTestTelegram}
                disabled={telegramStatus === "sending"}
                className={cn(
                  "w-full border border-border text-[11px] tracking-widest uppercase py-3 px-4 transition-colors",
                  telegramStatus === "sending"
                    ? "text-muted-foreground cursor-wait"
                    : telegramStatus === "ok"
                    ? "border-[var(--signal-confirmed)] text-[var(--signal-confirmed)]"
                    : telegramStatus === "error"
                    ? "border-[var(--short-color)] text-[var(--short-color)]"
                    : "text-muted-foreground hover:text-foreground hover:border-foreground/40"
                )}
                aria-label="Send test Telegram message"
              >
                {telegramStatus === "sending"
                  ? "Sending..."
                  : telegramStatus === "ok"
                  ? "Message Sent"
                  : telegramStatus === "error"
                  ? "Send Failed"
                  : "Test Telegram"}
              </button>
              {telegramMsg && (
                <p
                  className={cn(
                    "text-[10px] text-center",
                    telegramStatus === "ok"
                      ? "text-[var(--signal-confirmed)]"
                      : "text-[var(--short-color)]"
                  )}
                >
                  {telegramMsg}
                </p>
              )}
            </div>
          </div>

          {/* Data Points */}
          <div className="border border-border rounded-sm bg-card p-5 flex flex-col gap-4">
            <p className="text-[10px] tracking-widest text-muted-foreground uppercase">
              Data Points
            </p>
            <div className="grid grid-cols-2 gap-4 flex-1">
              <div className="flex flex-col gap-1">
                <p className="text-[10px] tracking-widest text-muted-foreground uppercase">
                  Assets
                </p>
                <p className="text-5xl font-bold text-[var(--signal-confirmed)] tabular-nums mt-1">
                  {SYMBOLS.length}
                </p>
              </div>
              <div className="flex flex-col gap-1">
                <p className="text-[10px] tracking-widest text-muted-foreground uppercase">
                  Signals
                </p>
                <p className="text-5xl font-bold text-[var(--signal-confirmed)] tabular-nums mt-1">
                  {activeSignalCount}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Signals section */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <p className="text-[10px] tracking-widest text-muted-foreground uppercase">
              Trendline Break Signals
            </p>
            <button
              onClick={handleRefresh}
              disabled={scanning}
              className={cn(
                "text-[10px] tracking-widest uppercase transition-colors",
                scanning
                  ? "text-muted-foreground/40 cursor-wait"
                  : "text-muted-foreground hover:text-foreground"
              )}
              aria-label="Refresh signals"
            >
              {scanning ? "Scanning..." : "Refresh"}
            </button>
          </div>

          {error && (
            <div className="border border-[var(--short-color)]/30 bg-[var(--short-color)]/5 rounded-sm p-4 text-[11px] text-[var(--short-color)] mb-4">
              Failed to load scan data. Check your connection and try refreshing.
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {displaySnapshots.map((snap) => (
              <SignalCard key={snap.symbol} snapshot={snap} />
            ))}
          </div>
        </div>

        {/* Footer */}
        <footer className="flex items-center justify-between pt-2 border-t border-border">
          <p className="text-[10px] text-muted-foreground/40 tracking-widest uppercase">
            Signal Dashboard v{APP_VERSION}
          </p>
          <p className="text-[10px] text-muted-foreground/40 tracking-widest">
            4H Breakout · 15M Confidence · 5M Trigger
          </p>
        </footer>
      </div>
    </main>
  );
}

function StatusRow({
  label,
  value,
  dot,
  dotColor,
  valueColor,
}: {
  label: string;
  value: string;
  dot?: boolean;
  dotColor?: string;
  valueColor?: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1.5">
        {dot && (
          <span
            className="h-1.5 w-1.5 rounded-full shrink-0"
            style={{ backgroundColor: dotColor }}
            aria-hidden="true"
          />
        )}
        <span className={cn("text-[11px] tracking-widest", valueColor)}>
          {value}
        </span>
      </div>
    </div>
  );
}
