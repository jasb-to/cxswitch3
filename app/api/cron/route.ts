import { evaluate } from "@/lib/engine";
import { sendTelegramMessage } from "@/app/api/telegram/route";
import { getPosition, setPosition, deletePosition, setCooldown, isCooldownActive } from "@/lib/position";
import { NextResponse } from "next/server";

const CRON_SECRET = process.env.CRON_SECRET;
const MIN_CONFIDENCE = 60;

export const dynamic = "force-dynamic";

function formatEnteredAlert(signal: any): string {
  const emoji = signal.state === "LONG" ? "🟢" : "🔴";
  return `${emoji} ENTERED: ${signal.symbol} ${signal.state} @ $${signal.entry?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}

SL: $${signal.stopLoss?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
TP: $${signal.takeProfit?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}

⏰ ${new Date().toLocaleTimeString()}`;
}

function formatExitedAlert(symbol: string, direction: string, exitPrice: number, entryPrice: number, isStopOut: boolean): string {
  const emoji = direction === "LONG" ? "🟢" : "🔴";
  const pnl = direction === "LONG" ? exitPrice - entryPrice : entryPrice - exitPrice;
  const pnlLabel = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
  const label = isStopOut ? "STOPPED OUT" : "EXITED";
  
  return `${emoji} ${label}: ${symbol} ${direction} @ $${exitPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}

PnL: ${pnlLabel}
⏰ ${new Date().toLocaleTimeString()}`;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    if (searchParams.get("secret") !== CRON_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.log("[CRON] Starting signal evaluation cycle...");

    const signals = await Promise.all([
      evaluate("BTC"),
      evaluate("ETH"),
      evaluate("SOL"),
    ]);

    const results = [];
    const alerts = [];

    for (const signal of signals) {
      console.log(`[CRON] ${signal.symbol}: state=${signal.state}, confidence=${signal.confidence}%`);

      // Check cooldown first
      const cooldownActive = await isCooldownActive(signal.symbol);
      if (cooldownActive) {
        console.log(`[CRON] ${signal.symbol}: Cooldown active, skipping`);
        results.push({
          symbol: signal.symbol,
          action: "skipped",
          reason: "cooldown_active",
        });
        continue;
      }

      // Get current position
      const position = await getPosition(signal.symbol);

      // Skip FLAT signals or low confidence
      if (signal.state === "FLAT") {
        results.push({
          symbol: signal.symbol,
          action: "skipped",
          reason: "no_signal",
        });
        continue;
      }

      // Check stop loss if position exists
      if (position) {
        const hitStopLoss =
          (position.direction === "LONG" && signal.price <= position.stopLoss) ||
          (position.direction === "SHORT" && signal.price >= position.stopLoss);

        if (hitStopLoss) {
          console.log(`[CRON] ${signal.symbol}: Stop loss hit at $${signal.price}`);
          const exitAlert = formatExitedAlert(signal.symbol, position.direction, signal.price, position.entryPrice, true);
          await sendTelegramMessage(exitAlert);
          await deletePosition(signal.symbol);
          await setCooldown(signal.symbol);
          alerts.push({ symbol: signal.symbol, type: "stopped_out", sent: true });
          results.push({
            symbol: signal.symbol,
            action: "stopped_out",
            exitPrice: signal.price,
            pnl: position.direction === "LONG" ? signal.price - position.entryPrice : position.entryPrice - signal.price,
          });
          continue;
        }

        // HOLD: Same direction
        if (signal.state === position.direction) {
          console.log(`[CRON] ${signal.symbol}: Holding ${position.direction} position`);
          results.push({
            symbol: signal.symbol,
            action: "hold",
            direction: position.direction,
          });
          continue;
        }

        // EXIT: Opposite direction
        if (signal.state !== position.direction) {
          console.log(`[CRON] ${signal.symbol}: Exiting ${position.direction} position (opposite signal)`);
          const exitAlert = formatExitedAlert(signal.symbol, position.direction, signal.price, position.entryPrice, false);
          await sendTelegramMessage(exitAlert);
          await deletePosition(signal.symbol);
          await setCooldown(signal.symbol);
          alerts.push({ symbol: signal.symbol, type: "exited", sent: true });
          results.push({
            symbol: signal.symbol,
            action: "exited",
            direction: position.direction,
            exitPrice: signal.price,
            pnl: position.direction === "LONG" ? signal.price - position.entryPrice : position.entryPrice - signal.price,
          });
          continue;
        }
      }

      // ENTER: No position, valid signal at 60%+ confidence
      if (!position && signal.confidence >= MIN_CONFIDENCE) {
        console.log(`[CRON] ${signal.symbol}: Entering ${signal.state} position`);

        // Store position
        await setPosition(signal.symbol, {
          direction: signal.state as "LONG" | "SHORT",
          entryPrice: signal.entry || signal.price,
          stopLoss: signal.stopLoss || (signal.state === "LONG" ? signal.price * 0.99 : signal.price * 1.01),
          takeProfit: signal.takeProfit || (signal.state === "LONG" ? signal.price * 1.03 : signal.price * 0.97),
          enteredAt: Date.now(),
        });

        // Send alert
        const enteredAlert = formatEnteredAlert(signal);
        await sendTelegramMessage(enteredAlert);
        alerts.push({ symbol: signal.symbol, type: "entered", sent: true });

        results.push({
          symbol: signal.symbol,
          action: "entered",
          direction: signal.state,
          entryPrice: signal.entry || signal.price,
          stopLoss: signal.stopLoss,
          takeProfit: signal.takeProfit,
        });
      } else if (!position && signal.confidence < MIN_CONFIDENCE) {
        results.push({
          symbol: signal.symbol,
          action: "skipped",
          reason: `confidence_${signal.confidence}%_below_${MIN_CONFIDENCE}%`,
        });
      }
    }

    console.log(`[CRON] Cycle complete: ${alerts.length} alerts sent`);

    return NextResponse.json({ results, alerts, timestamp: Date.now() });

  } catch (err: any) {
    console.error("[CRON] Fatal error:", err);
    return NextResponse.json({ error: err.message }, { status: 200 });
  }
}
