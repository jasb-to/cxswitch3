/**
 * Signal Payload Serialization & Validation Layer (v2.7.0)
 * 
 * Ensures only schema-valid, runtime-sanitized payloads reach Supabase.
 * Decouples internal strategy states from persistence states.
 */

export type SignalInsert = {
  symbol: string;
  direction: "LONG" | "SHORT";
  state: "EARLY_OPEN" | "CONFIRMED" | "END";
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  confidence: number;
  breakout_level: number;
};

const ALLOWED_STATES = ["EARLY_OPEN", "CONFIRMED", "END"] as const;
const ALLOWED_DIRECTIONS = ["LONG", "SHORT"] as const;

/**
 * Validates signal payload against strict schema rules.
 * Rejects unknown keys, invalid enums, missing required fields.
 */
export function validateSignalPayload(payload: unknown): payload is SignalInsert {
  if (!payload || typeof payload !== "object") {
    throw new Error("Payload must be a non-null object");
  }

  const p = payload as Record<string, unknown>;

  // Check for unknown keys
  const allowedKeys = new Set(["symbol", "direction", "state", "entry_price", "stop_loss", "take_profit", "confidence", "breakout_level"]);
  const unknownKeys = Object.keys(p).filter(k => !allowedKeys.has(k));
  if (unknownKeys.length > 0) {
    throw new Error(`Unknown fields in payload: ${unknownKeys.join(", ")}`);
  }

  // Validate required fields
  if (!p.symbol || typeof p.symbol !== "string") {
    throw new Error("Missing or invalid 'symbol' (must be string)");
  }
  if (!p.direction || !ALLOWED_DIRECTIONS.includes(p.direction as any)) {
    throw new Error(`Invalid 'direction': ${p.direction}. Must be LONG or SHORT`);
  }
  if (!p.state || !ALLOWED_STATES.includes(p.state as any)) {
    throw new Error(`Invalid 'state': ${p.state}. Must be EARLY_OPEN, CONFIRMED, or END`);
  }
  if (typeof p.entry_price !== "number") {
    throw new Error("Missing or invalid 'entry_price' (must be number)");
  }
  if (typeof p.stop_loss !== "number") {
    throw new Error("Missing or invalid 'stop_loss' (must be number)");
  }
  if (typeof p.take_profit !== "number") {
    throw new Error("Missing or invalid 'take_profit' (must be number)");
  }
  if (typeof p.confidence !== "number" || p.confidence < 0 || p.confidence > 100) {
    throw new Error("Missing or invalid 'confidence' (must be 0-100)");
  }
  if (typeof p.breakout_level !== "number") {
    throw new Error("Missing or invalid 'breakout_level' (must be number)");
  }

  return true;
}

/**
 * Pre-insert logging: minimal, structured output.
 * Shows only essential fields for debugging without exposing internals.
 */
export function logPreInsert(payload: SignalInsert): void {
  console.log(
    `[SIGNAL PRE-INSERT] ${payload.symbol} | ${payload.state} | ${payload.direction} | ` +
    `entry: $${payload.entry_price.toFixed(2)} | conf: ${payload.confidence}%`
  );
}

/**
 * Structured error logging for failed inserts.
 * Captures reason and full payload for debugging.
 */
export function logInsertError(reason: string, payload: SignalInsert): void {
  console.error(`[SIGNAL INSERT BLOCKED] ${reason}`, {
    symbol: payload.symbol,
    direction: payload.direction,
    state: payload.state,
    entry_price: payload.entry_price,
  });
}
