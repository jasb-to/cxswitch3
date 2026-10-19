// lib/supabase-kv.ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type SetOptions = { nx?: boolean; ex?: number; timeoutMs?: number };
type Row = { key: string; value: unknown; expires_at: string | null };

// Bound every persistence request so Supabase stalls fail fast instead of
// consuming the entire Vercel cron execution window.
const DEFAULT_QUERY_TIMEOUT_MS = 2000;
const CLEANUP_QUERY_TIMEOUT_MS = 2000;
const KEY_QUERY_TIMEOUTS: Record<string, number> = { "cxswitch:signal_history": 4000, "cxswitch:signal_history_archive": 4000, "cxswitch:market": 4000 };
const timeoutFor = (key: string) => KEY_QUERY_TIMEOUTS[key] ?? DEFAULT_QUERY_TIMEOUT_MS;
const MAX_OPERATION_RETRIES = 1;
const RETRY_DELAY_MS = 200;

async function withRetry<T>(
  opName: string,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  maxRetries = MAX_OPERATION_RETRIES,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const started = Date.now();
    try {
      const result = await operation(AbortSignal.timeout(timeoutMs));
      console.log(`[KV] ${opName} took ${Date.now() - started}ms attempt=${attempt + 1} status=ok`);
      return result;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[KV] ${opName} took ${Date.now() - started}ms attempt=${attempt + 1} status=error error=${message}`);
      if (attempt < maxRetries) await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Unknown KV error"));
}

let client: SupabaseClient | null = null;

function getClient() {
  if (client) return client;
  const rawUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!rawUrl || !key) throw new Error("Supabase persistence is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");

  // Accept the normal project API URL, or recover a dashboard URL copied from Supabase.
  let url = rawUrl.trim().replace(/\/$/, "");
  const dashboardMatch = url.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)(?:\/|$)/i);
  if (dashboardMatch) url = "https://" + dashboardMatch[1] + ".supabase.co";

  client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return client;
}

function expiry(ex?: number) {
  return ex && ex > 0 ? new Date(Date.now() + ex * 1000).toISOString() : null;
}

export class Redis {
  // Resolve credentials on first database operation, not during module import/build-time route analysis.
  // Runtime persistence calls still fail loudly if the required production credentials are absent.
  private get db(): SupabaseClient {
    return getClient();
  }

  async get<T = unknown>(key: string, maxRetries = MAX_OPERATION_RETRIES): Promise<T | null> {
    return withRetry(`get:${key}`, timeoutFor(key), async signal => {
      const { data, error } = await this.db.from("cxswitch_kv").select("key,value,expires_at").eq("key", key).abortSignal(signal).maybeSingle();
      if (error) throw new Error(`Supabase KV get failed for ${key}: ${error.message}`);
      if (!data) { console.log(`[KV SIZE] ${key}: 0 bytes (missing)`); return null; }
      console.log(`[KV SIZE] ${key}: ${new TextEncoder().encode(JSON.stringify(data.value) ?? "").length} bytes`);
      if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) {
        void withRetry(`delete-expired:${key}`, DEFAULT_QUERY_TIMEOUT_MS, async deleteSignal => {
          const { error: deleteError } = await this.db.from("cxswitch_kv").delete().eq("key", key).lte("expires_at", new Date().toISOString()).abortSignal(deleteSignal);
          if (deleteError) throw new Error(`Supabase KV expired delete failed for ${key}: ${deleteError.message}`);
          return true;
        }).catch(cleanupError => console.warn(`[KV] Expired-key cleanup skipped for ${key}: ${String(cleanupError)}`));
        return null;
      }
      return data.value as T;
    }, maxRetries);
  }

  async set(key: string, value: unknown, options: SetOptions = {}): Promise<"OK" | null> {
    const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? timeoutFor(key), Math.max(DEFAULT_QUERY_TIMEOUT_MS, ...Object.values(KEY_QUERY_TIMEOUTS))));
    const expiresAt = expiry(options.ex);
    if (!options.nx) console.log(`[KV SIZE] ${key}: ${new TextEncoder().encode(JSON.stringify(value) ?? "").length} bytes (write)`);
    if (options.nx) {
      // NX claims are one-shot. Do not retry an ambiguous timeout as that could
      // blur the difference between our claim and another caller's successful claim.
      return withRetry<"OK" | null>(`claim:${key}`, timeoutMs, async signal => {
        const { data, error } = await this.db.rpc("cxswitch_kv_claim", { p_key: key, p_value: value, p_expires_at: expiresAt }).abortSignal(signal);
        if (error) throw new Error(`Supabase KV claim failed for ${key}: ${error.message}`);
        return data === true ? "OK" : null;
      }, 0);
    }
    return withRetry<"OK" | null>(`set:${key}`, timeoutMs, async signal => {
      const { error } = await this.db.from("cxswitch_kv").upsert({ key, value, expires_at: expiresAt }, { onConflict: "key" }).abortSignal(signal);
      if (error) throw new Error(`Supabase KV set failed for ${key}: ${error.message}`);
      return "OK";
    });
  }

  async cleanupExpired(): Promise<number> {
    return withRetry("cleanup-expired", CLEANUP_QUERY_TIMEOUT_MS, async signal => {
      const { data, error } = await this.db.rpc("cxswitch_kv_cleanup_expired").abortSignal(signal);
      if (error) throw new Error(`Supabase KV cleanup failed: ${error.message}`);
      return Number(data ?? 0);
    });
  }

  async prunePrefix(prefix: string, keep: number): Promise<number> {
    const data = await withRetry(`prune-select:${prefix}`, CLEANUP_QUERY_TIMEOUT_MS, async signal => {
      const { data, error } = await this.db.from("cxswitch_kv").select("key,updated_at").like("key", `${prefix}%`).order("updated_at", { ascending: false }).abortSignal(signal);
      if (error) throw new Error(`Supabase KV prune failed for ${prefix}: ${error.message}`);
      return data ?? [];
    });
    const stale = data.slice(Math.max(0, keep)).map((row: { key: string }) => row.key);
    if (!stale.length) return 0;
    return withRetry(`prune-delete:${prefix}`, CLEANUP_QUERY_TIMEOUT_MS, async signal => {
      const { error } = await this.db.from("cxswitch_kv").delete().in("key", stale).abortSignal(signal);
      if (error) throw new Error(`Supabase KV prune delete failed for ${prefix}: ${error.message}`);
      return stale.length;
    });
  }

  async del(key: string, maxRetries = MAX_OPERATION_RETRIES): Promise<number> {
    return withRetry(`delete:${key}`, DEFAULT_QUERY_TIMEOUT_MS, async signal => {
      const { data, error } = await this.db.from("cxswitch_kv").delete().eq("key", key).select("key").abortSignal(signal);
      if (error) throw new Error(`Supabase KV delete failed for ${key}: ${error.message}`);
      return data?.length ?? 0;
    }, maxRetries);
  }
}
