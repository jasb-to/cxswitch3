// lib/supabase-kv.ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type SetOptions = { nx?: boolean; ex?: number };
type Row = { key: string; value: unknown; expires_at: string | null };

let client: SupabaseClient | null = null;

function getClient() {
  if (client) return client;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase persistence is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return client;
}

function expiry(ex?: number) {
  return ex && ex > 0 ? new Date(Date.now() + ex * 1000).toISOString() : null;
}

export class Redis {
  private db = getClient();

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

  async del(key: string): Promise<number> {
    const { data, error } = await this.db.from("cxswitch_kv").delete().eq("key", key).select("key");
    if (error) throw new Error(`Supabase KV delete failed for ${key}: ${error.message}`);
    return data?.length ?? 0;
  }
}
