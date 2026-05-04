"use client";

import type { SymbolSnapshot } from "@/lib/strategy";
import { cn } from "@/lib/utils";

interface SignalCardProps {
  snapshot: SymbolSnapshot;
}

function fmtPrice(n: number): string {
  if (n === 0) return "—";
  if (n >= 10000)
    return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (n >= 1000)
    return `$${n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  return `$${n.toFixed(2)}`;
}

const STATE_LABEL: Record<string, string> = {
  EARLY: "EARLY SIGNAL",
  CONFIRMED: "CONFIRMED",
  END: "CLOSED",
};

export function SignalCard({ snapshot }: SignalCardProps) {
  const { symbol, price, breakout, checklist, signal } = snapshot;
  const hasSignal = signal !== null && signal.state !== "END";
  const stateLabel = signal ? STATE_LABEL[signal.state] ?? signal.state : "CLOSED";

  const cardClass = cn(
    "rounded-sm border border-border bg-card flex flex-col",
    !hasSignal && "opacity-70"
  );

  return (
    <article className={cardClass} aria-label={`${symbol}/USD signal card`}>
      {/* Card header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <span className="font-mono text-base font-bold text-foreground tracking-tight">
          {symbol}
          <span className="text-muted-foreground font-normal">/USD</span>
        </span>
        <span
          className={cn(
            "font-mono text-[10px] tracking-widest px-2 py-0.5 border",
            signal?.state === "CONFIRMED"
              ? "border-[var(--signal-confirmed)] text-[var(--signal-confirmed)]"
              : signal?.state === "EARLY"
              ? "border-[var(--signal-early)] text-[var(--signal-early)]"
              : "border-border text-muted-foreground"
          )}
        >
          {stateLabel}
        </span>
      </div>

      <div className="px-4 py-3 flex flex-col gap-4">
        {/* Price */}
        <div>
          <p className="font-mono text-[9px] text-muted-foreground uppercase tracking-widest mb-0.5">
            Price
          </p>
          <p className="font-mono text-2xl font-semibold text-foreground tabular-nums">
            {fmtPrice(price)}
          </p>
        </div>

        {/* Breakout direction */}
        <div>
          <p className="font-mono text-[9px] text-muted-foreground uppercase tracking-widest mb-0.5">
            Breakout
          </p>
          <p
            className={cn(
              "font-mono text-sm font-bold tracking-wide",
              breakout === "LONG"
                ? "text-[var(--long-color)]"
                : breakout === "SHORT"
                ? "text-[var(--short-color)]"
                : "text-foreground"
            )}
          >
            {breakout === "NONE" ? "NONE" : breakout}
          </p>
        </div>

        {/* Entry / SL / TP — only when EARLY or CONFIRMED */}
        {hasSignal && signal && (
          <div className="grid grid-cols-3 gap-2">
            <PriceLevel label="Entry" value={fmtPrice(signal.entry)} />
            <PriceLevel
              label="TP1"
              value={fmtPrice(signal.tp)}
              className="text-[var(--long-color)]"
            />
            <PriceLevel
              label="SL"
              value={fmtPrice(signal.sl)}
              className="text-[var(--short-color)]"
            />
          </div>
        )}

        {/* Confidence */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <p className="font-mono text-[9px] text-muted-foreground uppercase tracking-widest">
              Confidence
            </p>
            {hasSignal && signal && (
              <p className="font-mono text-[9px] text-muted-foreground uppercase tracking-widest">
                Risk Profile
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-foreground w-8 shrink-0">
              {signal ? `${signal.confidence}%` : "0%"}
            </span>
            <div className="flex-1 h-px bg-border overflow-hidden">
              <div
                className={cn(
                  "h-full transition-all duration-700",
                  (signal?.confidence ?? 0) >= 70
                    ? "bg-[var(--signal-confirmed)]"
                    : (signal?.confidence ?? 0) >= 40
                    ? "bg-[var(--signal-early)]"
                    : "bg-border"
                )}
                style={{ width: `${signal?.confidence ?? 0}%` }}
                role="progressbar"
                aria-valuenow={signal?.confidence ?? 0}
                aria-valuemin={0}
                aria-valuemax={100}
              />
            </div>
          </div>
        </div>

        {/* Divider */}
        <div className="border-t border-border" />

        {/* Checklist */}
        <div>
          <p className="font-mono text-[9px] text-muted-foreground uppercase tracking-widest mb-2">
            Why
          </p>
          <ul className="flex flex-col gap-1.5" aria-label="Strategy checklist">
            {checklist.map((item, i) => (
              <li key={i} className="flex items-start gap-2">
                <span
                  className={cn(
                    "mt-0.5 shrink-0 h-3.5 w-3.5 rounded-sm border flex items-center justify-center",
                    item.passed
                      ? "border-[var(--signal-confirmed)] bg-[var(--signal-confirmed)]/10"
                      : "border-border bg-transparent"
                  )}
                  aria-hidden="true"
                >
                  {item.passed && (
                    <svg
                      width="8"
                      height="6"
                      viewBox="0 0 8 6"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M1 3L3 5L7 1"
                        stroke="var(--signal-confirmed)"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </span>
                <span
                  className={cn(
                    "font-mono text-[10px] leading-relaxed",
                    item.passed ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  {item.label}
                  {item.detail && (
                    <span className="block text-[9px] text-muted-foreground/60 mt-0.5">
                      {item.detail}
                    </span>
                  )}
                </span>
              </li>
            ))}
            {checklist.length === 0 && (
              <li className="font-mono text-[10px] text-muted-foreground/50">
                No data yet — run a scan
              </li>
            )}
          </ul>
        </div>
      </div>
    </article>
  );
}

function PriceLevel({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 bg-secondary/40 rounded-sm px-2.5 py-2">
      <span className="font-mono text-[9px] text-muted-foreground uppercase tracking-widest">
        {label}
      </span>
      <span
        className={cn(
          "font-mono text-xs font-semibold tabular-nums text-foreground",
          className
        )}
      >
        {value}
      </span>
    </div>
  );
}
