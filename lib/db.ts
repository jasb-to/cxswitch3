import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

let supabase: any = null;

// Only create client if env vars are available
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
}

export interface Signal {
  symbol: string;
  state: "DO_NOT_TRADE" | "BUILDING" | "SNIPER";
  price: number;
  bias_4h: string;
  bias_15m: string;
  macro: string;
  activation: string;
  signal_quality: number;
  trade?: any;
  updated_at: string;
}

/**
 * Get all signals from Supabase
 */
export async function getSignals(): Promise<Signal[]> {
  if (!supabase) {
    console.warn("[DB] Supabase not configured, returning empty signals");
    return [];
  }

  try {
    const { data, error } = await supabase
      .from("signals")
      .select("*")
      .order("updated_at", { ascending: false });

    if (error) {
      console.error("[DB] Error fetching signals:", error);
      return [];
    }

    return data || [];
  } catch (err) {
    console.error("[DB] Exception fetching signals:", err);
    return [];
  }
}

/**
 * Upsert a single signal to Supabase
 */
export async function setSignal(signal: Signal): Promise<boolean> {
  if (!supabase) {
    console.warn("[DB] Supabase not configured, skipping setSignal");
    return false;
  }

  try {
    const { error } = await supabase
      .from("signals")
      .upsert([signal], { onConflict: "symbol" });

    if (error) {
      console.error("[DB] Error upserting signal:", error);
      return false;
    }

    return true;
  } catch (err) {
    console.error("[DB] Exception upserting signal:", err);
    return false;
  }
}

/**
 * Upsert multiple signals to Supabase
 */
export async function setSignals(signals: Signal[]): Promise<boolean> {
  if (!supabase) {
    console.warn("[DB] Supabase not configured, skipping setSignals");
    return false;
  }

  try {
    const { error } = await supabase
      .from("signals")
      .upsert(signals, { onConflict: "symbol" });

    if (error) {
      console.error("[DB] Error upserting signals:", error);
      return false;
    }

    return true;
  } catch (err) {
    console.error("[DB] Exception upserting signals:", err);
    return false;
  }
}

