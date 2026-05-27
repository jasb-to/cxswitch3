import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

export async function logTrade(trade: {
  symbol: string;
  direction: "LONG" | "SHORT";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  orderId?: string;
  error?: string;
}): Promise<void> {
  try {
    const { error } = await supabase.from("trades").insert({
      symbol: trade.symbol,
      direction: trade.direction,
      entry: trade.entry,
      stop_loss: trade.stopLoss,
      take_profit: trade.takeProfit,
      confidence: trade.confidence,
      order_id: trade.orderId || null,
      error: trade.error || null,
      created_at: new Date().toISOString(),
    });

    if (error) {
      console.error("[Supabase] Trade log error:", error);
    }
  } catch (err) {
    console.error("[Supabase] Error:", err);
  }
}
