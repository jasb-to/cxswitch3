/**
 * PURE STATE MACHINE - NO INTERPRETATION
 * 
 * Maps canonicalState → UI display ONLY.
 * NO narrative generation.
 * NO explanation logic.
 * NO indicator reinterpretation.
 * 
 * Accepts input, returns styled output.
 * Nothing more.
 */

import type { SymbolCardState } from "./strategy-v6";

export type UIState = "BUILDING" | "SNIPER" | "ACTIVE_SNIPER" | "CONFIRMED";

/**
 * Pure state mapping: backend signal → display state
 * No interpretation. No logic. No fallback explanation.
 */
export function resolveDisplayState(card: SymbolCardState): UIState {
  if (card.source === "bootstrap") return "BUILDING";

  const s = (card as any).signalState as string | undefined;

  if (s === "ACTIVE_SNIPER") return "ACTIVE_SNIPER";
  if (s === "ACTIVE_CONFIRMED") return "CONFIRMED";
  if (s === "SNIPER") return "SNIPER";
  
  return "BUILDING";
}

export function getFinalState(card: SymbolCardState): UIState {
  return resolveDisplayState(card);
}

export function safePercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const clamped = Math.max(0, Math.min(100, value));
  return `${Math.round(clamped)}%`;
}

export function safeBarWidth(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "0%";
  const clamped = Math.max(0, Math.min(100, value));
  return `${clamped}%`;
}

export function getReadinessColorClass(score: number | null | undefined): string {
  if (score === null || score === undefined || !Number.isFinite(score)) return "text-zinc-500";
  if (score < 40) return "text-red-500";
  if (score < 60) return "text-yellow-500";
  if (score < 75) return "text-blue-500";
  return "text-green-500";
}

export function getReadinessBarClass(score: number | null | undefined): string {
  if (score === null || score === undefined || !Number.isFinite(score)) return "bg-zinc-900";
  if (score < 40) return "bg-red-500";
  if (score < 60) return "bg-yellow-500";
  if (score < 75) return "bg-blue-500";
  return "bg-green-500";
}

export function getStateColorClass(state: UIState): string {
  switch (state) {
    case "ACTIVE_SNIPER": return "border-cyan-700 bg-cyan-950 text-cyan-400";
    case "SNIPER": return "border-blue-700 bg-blue-900 text-blue-200";
    case "CONFIRMED": return "border-green-700 bg-green-900 text-green-200";
    case "BUILDING": return "border-zinc-700 bg-zinc-800 text-zinc-300";
    default: return "border-zinc-700 bg-zinc-800 text-zinc-300";
  }
}
