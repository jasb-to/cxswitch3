// lib/supabase-kv.ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type SetOptions = { nx?: boolean; ex?: number };
type Row = { key: string; value: unknown; expires_at: string | null };

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

  async get<T = unknown>(key: string): Promise<T | null> {
    const { data, error } = await this.db.from("cxswitch_kv").select("key,value,expires_at").eq("key", key).maybeSingle();
    if (error) throw new Error(`Supabase KV get failed for ${key}: ${error.message}`);
    if (!data) return null;
    if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) {
      await this.db.from("cxswitch_kv").delete().eq("key", key);
      return null;
    }
    return data.value as T;
  }

  async set(key: string, value: unknown, options: SetOptions = {}): Promise<"OK" | null> {
    const expiresAt = expiry(options.ex);
    if (options.nx) {
      const { data, error } = await this.db.rpc("cxswitch_kv_claim", { p_key: key, p_value: value, p_expires_at: expiresAt });
      if (error) throw new Error(`Supabase KV claim failed for ${key}: ${error.message}`);
      return data === true ? "OK" : null;
    }
    const { error } = await this.db.from("cxswitch_kv").upsert({ key, value, expires_at: expiresAt }, { onConflict: "key" });
    if (error) throw new Error(`Supabase KV set failed for ${key}: ${error.message}`);
    return "OK";
  }

  async cleanupExpired(): Promise<number> {
    const { data, error } = await this.db.rpc("cxswitch_kv_cleanup_expired");
    if (error) throw new Error(`Supabase KV cleanup failed: ${error.message}`);
    return Number(data ?? 0);
  }

  async prunePrefix(prefix: string, keep: number): Promise<number> {
    const { data, error } = await this.db
      .from("cxswitch_kv")
      .select("key,updated_at")
      .like("key", `${prefix}%`)
      .order("updated_at", { ascending: false });
    if (error) throw new Error(`Supabase KV prune failed for ${prefix}: ${error.message}`);
    const stale = (data ?? []).slice(Math.max(0, keep)).map((row: { key: string }) => row.key);
    if (!stale.length) return 0;
    const { error: deleteError } = await this.db.from("cxswitch_kv").delete().in("key", stale);
    if (deleteError) throw new Error(`Supabase KV prune delete failed for ${prefix}: ${deleteError.message}`);
    return stale.length;
  }

  async del(key: string): Promise<number> {
    const { data, error } = await this.db.from("cxswitch_kv").delete().eq("key", key).select("key");
    if (error) throw new Error(`Supabase KV delete failed for ${key}: ${error.message}`);
    return data?.length ?? 0;
  }
}
