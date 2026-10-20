// lib/supabase-kv.ts
// Compatibility adapter for the existing state-store interface, backed by
// Layerbase's Upstash-compatible Redis REST API. Filename retained to keep
// this migration narrowly scoped and preserve all existing state call sites.
type SetOptions = { nx?: boolean; ex?: number; timeoutMs?: number };
const DEFAULT_QUERY_TIMEOUT_MS = 8_000;
const CLEANUP_QUERY_TIMEOUT_MS = 8_000;
const MAX_OPERATION_RETRIES = 1;
const RETRY_DELAY_MS = 250;
type RestResponse<T = unknown> = { result?: T; error?: string };

function credentials() {
  const url = process.env.REDIS_REST_URL?.trim().replace(/\/$/, "");
  const token = process.env.REDIS_REST_TOKEN?.trim();
  if (!url || !token) throw new Error("Layerbase Redis is not configured: set REDIS_REST_URL and REDIS_REST_TOKEN");
  return { url, token };
}

async function command<T = unknown>(args: Array<string | number>, timeoutMs = DEFAULT_QUERY_TIMEOUT_MS): Promise<T> {
  const { url, token } = credentials();
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  let payload: RestResponse<T>;
  try { payload = await response.json() as RestResponse<T>; }
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
      console.log(`[KV] ${opName} took ${Date.now() - started}ms attempt=${attempt + 1} status=ok`);
      return result;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[KV] ${opName} took ${Date.now() - started}ms attempt=${attempt + 1} status=error error=${message}`);
      if (attempt < maxRetries) await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Unknown Redis REST error"));
}

function encodeValue(value: unknown): string { return JSON.stringify(value); }
function decodeValue<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value as T;
  try { return JSON.parse(value) as T; } catch { return value as T; }
}

export class Redis {
  async get<T = unknown>(key: string, maxRetries = MAX_OPERATION_RETRIES): Promise<T | null> {
    return withRetry(`get:${key}`, DEFAULT_QUERY_TIMEOUT_MS, async () => {
      const value = await command<unknown>(["GET", key]);
      const decoded = decodeValue<T>(value);
      const bytes = value == null ? 0 : new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).length;
      console.log(`[KV SIZE] ${key}: ${bytes} bytes`);
      return decoded;
    }, maxRetries);
  }

  async set(key: string, value: unknown, options: SetOptions = {}): Promise<"OK" | null> {
    const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS, DEFAULT_QUERY_TIMEOUT_MS));
    const args: Array<string | number> = ["SET", key, encodeValue(value)];
    if (options.nx) args.push("NX");
    if (options.ex && options.ex > 0) args.push("EX", options.ex);
    if (!options.nx) console.log(`[KV SIZE] ${key}: ${new TextEncoder().encode(encodeValue(value)).length} bytes (write)`);
    // NX claims are never retried: claimCronLock verifies token ownership after
    // an ambiguous timeout and fails closed if ownership cannot be established.
    return withRetry(options.nx ? `claim:${key}` : `set:${key}`, timeoutMs, async () => {
      const result = await command<string | null>(args, timeoutMs);
      return result === "OK" ? "OK" : null;
    }, options.nx ? 0 : MAX_OPERATION_RETRIES);
  }

  async cleanupExpired(): Promise<number> {
    // Redis expires keys natively, so there is no database-wide cleanup query.
    return 0;
  }

  async prunePrefix(_prefix: string, _keep: number): Promise<number> {
    // Telegram alert-deduplication keys are written with a six-hour EX TTL.
    // Do not SCAN an unordered keyspace to guess which keys are oldest: TTL is
    // the bounded-retention mechanism, and avoiding SCAN saves requests.
    return 0;
  }

  async del(key: string, maxRetries = MAX_OPERATION_RETRIES): Promise<number> {
    return withRetry(`delete:${key}`, DEFAULT_QUERY_TIMEOUT_MS, async () =>
      Number(await command<number>(["DEL", key])), maxRetries);
  }
}
