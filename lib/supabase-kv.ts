// lib/supabase-kv.ts
// Shared state-store adapter. Temporary default: durable Supabase Postgres KV
// while Layerbase is asleep. Set CXSWITCH_KV_PROVIDER=layerbase to switch back
// after Layerbase is available and its state has been reconciled.
type SetOptions = { nx?: boolean; ex?: number; timeoutMs?: number };
const DEFAULT_QUERY_TIMEOUT_MS = 8_000;
const MAX_OPERATION_RETRIES = 1;
const RETRY_DELAY_MS = 250;
type RedisRestResponse<T = unknown> = { result?: T; error?: string };

function provider(): "supabase" | "layerbase" {
  return process.env.CXSWITCH_KV_PROVIDER?.trim().toLowerCase() === "layerbase" ? "layerbase" : "supabase";
}

function supabaseCredentials() {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/$/, "");
  const token = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !token) throw new Error("Supabase KV is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  return { url, token };
}

function layerbaseCredentials() {
  const url = process.env.REDIS_REST_URL?.trim().replace(/\/$/, "");
  const token = process.env.REDIS_REST_TOKEN?.trim();
  if (!url || !token) throw new Error("Layerbase Redis is not configured: set REDIS_REST_URL and REDIS_REST_TOKEN");
  return { url, token };
}

async function supabaseRequest<T = unknown>(path: string, init: RequestInit = {}, timeoutMs = DEFAULT_QUERY_TIMEOUT_MS): Promise<T> {
  const { url, token } = supabaseCredentials();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: token,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try { payload = JSON.parse(text); }
    catch { throw new Error(`Supabase KV returned non-JSON response (HTTP ${response.status})`); }
  }
  if (!response.ok) {
    const message = typeof payload === "object" && payload !== null && "message" in payload
      ? String((payload as { message: unknown }).message)
      : response.statusText;
    throw new Error(`Supabase KV request failed (HTTP ${response.status}): ${message}`);
  }
  return payload as T;
}

async function layerbaseCommand<T = unknown>(args: Array<string | number>, timeoutMs = DEFAULT_QUERY_TIMEOUT_MS): Promise<T> {
  const { url, token } = layerbaseCredentials();
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  let payload: RedisRestResponse<T>;
  try { payload = await response.json() as RedisRestResponse<T>; }
  catch { throw new Error(`Layerbase Redis REST returned non-JSON response (HTTP ${response.status})`); }
  if (!response.ok || payload.error) {
    throw new Error(`Layerbase Redis command ${String(args[0]).toUpperCase()} failed (HTTP ${response.status}): ${payload.error ?? response.statusText}`);
  }
  return payload.result as T;
}

async function withRetry<T>(opName: string, timeoutMs: number, operation: () => Promise<T>, maxRetries = MAX_OPERATION_RETRIES): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const started = Date.now();
    try {
      const result = await operation();
      console.log(`[KV] ${opName} provider=${provider()} took ${Date.now() - started}ms attempt=${attempt + 1} status=ok`);
      return result;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[KV] ${opName} provider=${provider()} took ${Date.now() - started}ms attempt=${attempt + 1} status=error error=${message}`);
      if (attempt < maxRetries) await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Unknown KV error"));
}

function encodeValue(value: unknown): string { return JSON.stringify(value); }

export class Redis {
  async get<T = unknown>(key: string, maxRetries = MAX_OPERATION_RETRIES): Promise<T | null> {
    return withRetry(`get:${key}`, DEFAULT_QUERY_TIMEOUT_MS, async () => {
      if (provider() === "layerbase") {
        const value = await layerbaseCommand<unknown>(["GET", key]);
        if (value === null || value === undefined) return null;
        if (typeof value !== "string") return value as T;
        try { return JSON.parse(value) as T; } catch { return value as T; }
      }

      const rows = await supabaseRequest<Array<{ value: T; expires_at: string | null }>>(
        `cxswitch_kv?select=value,expires_at&key=eq.${encodeURIComponent(key)}&limit=1`,
      );
      const row = rows[0];
      if (!row) return null;
      if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
        await supabaseRequest(`cxswitch_kv?key=eq.${encodeURIComponent(key)}&expires_at=lte.${encodeURIComponent(new Date().toISOString())}`, { method: "DELETE" });
        return null;
      }
      return row.value ?? null;
    }, maxRetries);
  }

  async set(key: string, value: unknown, options: SetOptions = {}): Promise<"OK" | null> {
    const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS, DEFAULT_QUERY_TIMEOUT_MS));
    return withRetry(options.nx ? `claim:${key}` : `set:${key}`, timeoutMs, async () => {
      if (provider() === "layerbase") {
        const args: Array<string | number> = ["SET", key, encodeValue(value)];
        if (options.nx) args.push("NX");
        if (options.ex && options.ex > 0) args.push("EX", options.ex);
        const result = await layerbaseCommand<string | null>(args, timeoutMs);
        return result === "OK" ? "OK" : null;
      }

      const expiresAt = options.ex && options.ex > 0 ? new Date(Date.now() + options.ex * 1000).toISOString() : null;
      if (options.nx) {
        // Remove expired rows first; the claim itself is an atomic INSERT ... ON CONFLICT DO NOTHING.
        await supabaseRequest("rpc/cxswitch_kv_cleanup_expired", { method: "POST", body: "{}" }, timeoutMs);
        const claimed = await supabaseRequest<boolean>("rpc/cxswitch_kv_claim", {
          method: "POST",
          body: JSON.stringify({ p_key: key, p_value: value, p_expires_at: expiresAt }),
        }, timeoutMs);
        return claimed ? "OK" : null;
      }

      await supabaseRequest("cxswitch_kv?on_conflict=key", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key, value, expires_at: expiresAt, updated_at: new Date().toISOString() }),
      }, timeoutMs);
      return "OK";
    }, options.nx ? 0 : MAX_OPERATION_RETRIES);
  }

  async cleanupExpired(): Promise<number> {
    if (provider() === "layerbase") return 0;
    return withRetry("cleanup-expired", DEFAULT_QUERY_TIMEOUT_MS, async () =>
      Number(await supabaseRequest<number>("rpc/cxswitch_kv_cleanup_expired", { method: "POST", body: "{}" })), 0);
  }

  async prunePrefix(_prefix: string, _keep: number): Promise<number> {
    // Alert dedupe rows are TTL-bounded and the DB has a safety cleanup routine.
    return 0;
  }

  async compareAndDelete(key: string, expectedToken: string): Promise<number> {
    if (provider() === "layerbase") {
      const script = "local v=redis.call('GET',KEYS[1]); if not v then return 0 end; local ok,o=pcall(cjson.decode,v); if ok and o.token==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0";
      return withRetry(`compare-delete:${key}`, DEFAULT_QUERY_TIMEOUT_MS, async () =>
        Number(await layerbaseCommand<number>(["EVAL", script, 1, key, expectedToken])), 0);
    }

    return withRetry(`compare-delete:${key}`, DEFAULT_QUERY_TIMEOUT_MS, async () => {
      // PostgREST applies the token predicate and DELETE in one SQL statement.
      const rows = await supabaseRequest<Array<{ key: string }>>(
        `cxswitch_kv?key=eq.${encodeURIComponent(key)}&value-%3E%3Etoken=eq.${encodeURIComponent(expectedToken)}&select=key`,
        { method: "DELETE", headers: { Prefer: "return=representation" } },
      );
      return rows.length;
    }, 0);
  }

  async del(key: string, maxRetries = MAX_OPERATION_RETRIES): Promise<number> {
    return withRetry(`delete:${key}`, DEFAULT_QUERY_TIMEOUT_MS, async () => {
      if (provider() === "layerbase") return Number(await layerbaseCommand<number>(["DEL", key]));
      const rows = await supabaseRequest<Array<{ key: string }>>(
        `cxswitch_kv?key=eq.${encodeURIComponent(key)}&select=key`,
        { method: "DELETE", headers: { Prefer: "return=representation" } },
      );
      return rows.length;
    }, maxRetries);
  }
}
