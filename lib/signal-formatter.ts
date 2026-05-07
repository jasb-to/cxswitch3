/**
 * Signal Formatter & Decision System (v2.8.3)
 * Transforms raw signals into decision-grade trading intelligence
 */

import type { Signal, MarketContext } from "./strategy";
import { calculateRiskReward } from "./risk-utils";

export type SignalGrade = "A" | "B" | "C" | "D";

export interface FormattedSignal {
  symbol: string;
  direction: string;
  state: string;
  score: number;
  grade: SignalGrade;
  entry: number;
  stop: number;
  target: number;
  rr: number;
  breakdown: SignalBreakdown;
  situation: string;
  trigger: string;
  risk: string;
}

export interface SignalBreakdown {
  structure: "strong" | "moderate" | "weak";
  trend: "bullish" | "bearish" | "neutral";
  momentum: "building" | "confirmed" | "failing";
  displacement: boolean;
}

/**
 * Calculate signal score (0-100) based on signal properties
 * Components: structure (0-40), trend (0-20), momentum (0-20), displacement (0-20)
 */
export function calculateSignalScore(
  signal: Signal,
  context?: MarketContext
): { score: number; breakdown: SignalBreakdown } {
  let score = 0;
  const breakdown: SignalBreakdown = {
    structure: "weak",
    trend: "neutral",
    momentum: "failing",
    displacement: false,
  };

  // Component 1: Structure strength (0-40)
  // High confidence = stronger structure
  if (signal.confidence >= 85) {
    score += 40;
    breakdown.structure = "strong";
  } else if (signal.confidence >= 70) {
    score += 25;
    breakdown.structure = "moderate";
  } else if (signal.confidence >= 50) {
    score += 12;
    breakdown.structure = "weak";
  }

  // Component 2: Trend alignment (0-20)
  if (context?.ema8 && context?.ema21) {
    const aligned = signal.direction === "LONG" ? context.ema8 > context.ema21 : context.ema8 < context.ema21;
    if (aligned) {
      score += 20;
      breakdown.trend = signal.direction === "LONG" ? "bullish" : "bearish";
    } else if (Math.abs(context.ema8 - context.ema21) < context.ema21 * 0.02) {
      score += 8;
      breakdown.trend = "neutral";
    }
  }

  // Component 3: Momentum (0-20)
  if (context?.emaCurling) {
    const momentumBuild = signal.direction === "LONG" ? context.emaCurling.curlingUp : context.emaCurling.curlingDown;
    if (momentumBuild) {
      score += 20;
      breakdown.momentum = "building";
    } else {
      score += 10;
      breakdown.momentum = "confirmed";
    }
  } else {
    score += 10;
    breakdown.momentum = "confirmed";
  }

  // Component 4: Displacement (0-20)
  // Signals with breakout expansion have displacement
  const rr = calculateRiskReward(signal.entry_price, signal.take_profit, signal.stop_loss, signal.direction);
  if (rr >= 3) {
    score += 20;
    breakdown.displacement = true;
  } else if (rr >= 2) {
    score += 12;
    breakdown.displacement = true;
  }

  return { score: Math.min(score, 100), breakdown };
}

/**
 * Map score to grade
 */
export function getGrade(score: number): SignalGrade {
  if (score >= 80) return "A";
  if (score >= 60) return "B";
  if (score >= 40) return "C";
  return "D";
}

/**
 * Format signal for decision-grade Telegram alert
 */
export function formatSignalForTelegram(
  signal: Signal,
  context?: MarketContext
): FormattedSignal {
  const { score, breakdown } = calculateSignalScore(signal, context);
  const grade = getGrade(score);
  const rr = calculateRiskReward(signal.entry_price, signal.take_profit, signal.stop_loss, signal.direction);

  const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Generate situation context
  let situation = "";
  if (context?.setupText) {
    situation = context.setupText.split(" — ").pop() || "Setup forming";
  } else if (signal.state === "EARLY_OPEN") {
    situation = `Early setup. Awaiting 15M confirmation for sustained breakout.`;
  } else {
    situation = `Breakout confirmed with sustained momentum.`;
  }

  // Generate trigger condition
  let trigger = "";
  if (signal.state === "EARLY_OPEN") {
    trigger = `Retest of breakout level and momentum continuation on 15M`;
  } else {
    trigger = `Sustained close above/below breakout level with volume confirmation`;
  }

  // Generate risk context
  let risk = "";
  if (breakdown.structure === "strong") {
    risk = `Low invalidation risk — structure is well-defined`;
  } else if (breakdown.structure === "moderate") {
    risk = `Moderate invalidation risk — watch for close below ${fmt(signal.stop_loss)}`;
  } else {
    risk = `High invalidation risk — premature entry possible, await confirmation`;
  }

  return {
    symbol: signal.symbol,
    direction: signal.direction,
    state: signal.state,
    score,
    grade,
    entry: signal.entry_price,
    stop: signal.stop_loss,
    target: signal.take_profit,
    rr,
    breakdown,
    situation,
    trigger,
    risk,
  };
}

/**
 * Generate Telegram message from formatted signal
 */
export function generateTelegramMessage(formatted: FormattedSignal): string {
  const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const stateEmoji = formatted.state === "CONFIRMED" ? "🟢" : "🟡";
  const directionEmoji = formatted.direction === "LONG" ? "📈" : "📉";

  return (
    `${stateEmoji} ${formatted.symbol} — ${directionEmoji} ${formatted.direction} (${formatted.state})\n` +
    `\n` +
    `💰 Entry: $${fmt(formatted.entry)}\n` +
    `🛑 Stop: $${fmt(formatted.stop)}\n` +
    `🎯 Target: $${fmt(formatted.target)}\n` +
    `\n` +
    `📊 Signal Score: ${formatted.score}/100\n` +
    `🏷 Quality Grade: ${formatted.grade}\n` +
    `\n` +
    `🧠 Setup Breakdown:\n` +
    `- Structure: ${formatted.breakdown.structure}\n` +
    `- Trend: ${formatted.breakdown.trend}\n` +
    `- Momentum: ${formatted.breakdown.momentum}\n` +
    `- Displacement: ${formatted.breakdown.displacement ? "yes" : "no"}\n` +
    `\n` +
    `📍 Current Situation:\n` +
    `${formatted.situation}\n` +
    `\n` +
    `⏳ Trigger Condition:\n` +
    `${formatted.trigger}\n` +
    `\n` +
    `⚠️ Risk Context:\n` +
    `${formatted.risk}\n` +
    `\n` +
    `Risk/Reward: ${formatted.rr.toFixed(2)}:1`
  );
}

/**
 * Generate dashboard checklist for a symbol
 */
export function generateChecklistItem(
  signal: Signal | null,
  context?: MarketContext
): string {
  if (!signal) {
    return `📍 ${context?.symbol || "?"} — NO_TRADE\nNo high-quality setup detected.`;
  }

  const { score, breakdown } = calculateSignalScore(signal, context);
  const grade = getGrade(score);

  const statusEmoji = signal.state === "CONFIRMED" ? "✅" : signal.state === "EARLY_OPEN" ? "🔄" : "❌";

  return (
    `${statusEmoji} ${signal.symbol}\n` +
    `Score: ${score}/100 | Grade: ${grade}\n` +
    `\n` +
    `Checklist:\n` +
    `✔ Structure Formation (${breakdown.structure})\n` +
    `✔ Trend Alignment (${breakdown.trend})\n` +
    `✔ Momentum Status (${breakdown.momentum})\n` +
    `✔ Displacement Present (${breakdown.displacement ? "yes" : "no"})\n` +
    `\n` +
    `→ ${signal.state}\n` +
    `Direction: ${signal.direction} | RR: ${calculateRiskReward(signal.entry_price, signal.take_profit, signal.stop_loss, signal.direction).toFixed(2)}:1`
  );
}
