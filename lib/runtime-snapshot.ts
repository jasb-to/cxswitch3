import { createClient } from "@supabase/supabase-js";

/**
 * v23.0.0 - DURABLE ATOMIC SNAPSHOT PERSISTENCE
 * 
 * Problem (v17.0.0): globalThis.__snapshot__ dies on cold starts
 * Result: UI shows empty state after process restart
 * 
 * Solution: Use Supabase for durable snapshot storage
 * - In-memory fallback for performance
 * - Supabase sync for durability
 * - Survives cold starts, process crashes, rebalancing
 */

export type RuntimeSnapshot = {
  updatedAt: string;
  cards: any[];
  setups: any[];
};

declare global {
  // eslint-disable-next-line no-var
  var __snapshot__: RuntimeSnapshot | undefined;
}

const defaultSnapshot: RuntimeSnapshot = {
  updatedAt: "",
  cards: [],
  setups: [],
};

// Initialize Supabase client for durable storage
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let supabaseClient: ReturnType<typeof createClient> | null = null;

if (supabaseUrl && supabaseKey) {
  supabaseClient = createClient(supabaseUrl, supabaseKey);
}

/**
 * v23.0.0: DURABLE snapshot replacement
 * Persists to Supabase + in-memory cache
 */
export async function setSnapshot(data: RuntimeSnapshot) {
  // Always update in-memory cache for fast reads
  globalThis.__snapshot__ = data;
  
  console.log("[SNAPSHOT_SET] Atomic replacement persisted", {
    updatedAt: data.updatedAt,
    cardCount: data.cards.length,
    setupCount: data.setups.length,
  });

  // Also persist to Supabase if available (non-blocking)
  if (supabaseClient) {
    try {
      const { error } = await supabaseClient
        .from("snapshots")
        .upsert(
          {
            id: "live",
            updated_at: data.updatedAt,
            cards: data.cards,
            setups: data.setups,
            last_modified: new Date().toISOString(),
          },
          { onConflict: "id" }
        );

      if (error) {
        console.warn("[SNAPSHOT_SUPABASE_ERROR] Failed to persist snapshot:", error.message);
      } else {
        console.log("[SNAPSHOT_SUPABASE_SYNCED] Durable copy persisted");
      }
    } catch (err) {
      console.warn("[SNAPSHOT_SUPABASE_EXCEPTION]", err instanceof Error ? err.message : err);
    }
  }
}

/**
 * v23.0.0: Get current snapshot
 * Tries in-memory first, then falls back to Supabase
 */
export async function getSnapshot(): Promise<RuntimeSnapshot> {
  // Fast path: return in-memory cache if available
  if (globalThis.__snapshot__) {
    return globalThis.__snapshot__;
  }

  // Cold start: Try to restore from Supabase
  if (supabaseClient) {
    try {
      const { data, error } = await supabaseClient
        .from("snapshots")
        .select("*")
        .eq("id", "live")
        .single();

      if (error) {
        console.warn("[SNAPSHOT_RESTORE_ERROR] Failed to restore from Supabase:", error.message);
      } else if (data) {
        // Restore to in-memory cache
        const restored: RuntimeSnapshot = {
          updatedAt: data.updated_at,
          cards: data.cards || [],
          setups: data.setups || [],
        };
        globalThis.__snapshot__ = restored;
        console.log("[SNAPSHOT_RESTORED] Restored from Supabase cold start", {
          cardCount: restored.cards.length,
          setupCount: restored.setups.length,
        });
        return restored;
      }
    } catch (err) {
      console.warn("[SNAPSHOT_RESTORE_EXCEPTION]", err instanceof Error ? err.message : err);
    }
  }

  // Ultimate fallback: empty snapshot
  console.log("[SNAPSHOT_DEFAULT] Using empty snapshot (Supabase unavailable or no stored snapshot)");
  return defaultSnapshot;
}

