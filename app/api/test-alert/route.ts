import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase-client";
import { sendSignalAlert } from "@/lib/telegram";

/**
 * Test endpoint for end-to-end signal insertion and Telegram alert verification
 * POST /api/test-alert
 * 
 * Inserts a test signal and triggers Telegram dispatch
 */
export async function POST(req: NextRequest) {
  try {
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const auth = req.headers.get("authorization");
      const query = new URL(req.url).searchParams.get("secret");
      if (auth !== `Bearer ${secret}` && query !== secret) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    // Test signal payload
    const testSignal = {
      symbol: "TEST/USD",
      direction: "LONG" as const,
      state: "EARLY_OPEN" as const,
      entry_price: 100,
      stop_loss: 99,
      take_profit: 102,
      confidence: 75,
      breakout_level: 100,
    };

    // Insert test signal
    const { data: inserted, error: insertErr } = await supabase
      .from("signals")
      .insert([testSignal])
      .select()
      .single();

    if (insertErr) {
      console.error("[TEST-ALERT] Insert failed:", insertErr.message);
      return NextResponse.json(
        { success: false, error: `Insert failed: ${insertErr.message}` },
        { status: 500 }
      );
    }

    if (!inserted) {
      return NextResponse.json(
        { success: false, error: "Insert succeeded but no signal returned" },
        { status: 500 }
      );
    }

    console.log("[TEST-ALERT] Signal inserted:", { id: inserted.id, symbol: inserted.symbol });

    // Verify persistence
    const { data: verify, error: verifyErr } = await supabase
      .from("signals")
      .select("*")
      .eq("id", inserted.id)
      .single();

    if (verifyErr || !verify) {
      console.error("[TEST-ALERT] Verification failed:", verifyErr?.message);
      return NextResponse.json(
        { success: false, error: "Signal inserted but not queryable" },
        { status: 500 }
      );
    }

    console.log("[TEST-ALERT] Signal verified in database");

    // Send Telegram alert
    try {
      await sendSignalAlert(verify);
      console.log("[TEST-ALERT] Telegram alert sent successfully");
      return NextResponse.json({
        success: true,
        signal: verify,
        message: "Test signal inserted and Telegram alert sent",
      });
    } catch (telegramErr) {
      console.error("[TEST-ALERT] Telegram send failed:", telegramErr);
      return NextResponse.json({
        success: true,
        signal: verify,
        warning: "Signal inserted but Telegram alert failed",
      });
    }
  } catch (err) {
    console.error("[TEST-ALERT] Error:", err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/test-alert — verify endpoint is accessible
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    const query = new URL(req.url).searchParams.get("secret");
    if (auth !== `Bearer ${secret}` && query !== secret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  return NextResponse.json({
    ok: true,
    message: "POST to /api/test-alert with CRON_SECRET to test end-to-end signal flow",
  });
}
