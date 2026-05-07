/**
 * Signal Payload Serialization & Validation Layer (v2.7.1)
 * 
 * Ensures only schema-valid, runtime-sanitized payloads reach Supabase.
 * Full fail-fast validation with explicit error reporting.
 */

// Active signal states constant — used in all query filters
export const ACTIVE_SIGNAL_STATES = ["EARLY_OPEN", "CONFIRMED"] as const;

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
 * Validation result type — fail-fast with explicit error collection
 */
export type ValidationResult = {
  valid: boolean;
  errors: string[];
};

/**
 * Strict numeric sanitization with NaN/finite checks.
 * Rejects invalid numeric values before validation.
 */
function sanitizeNumeric(value: unknown, fieldName: string): { valid: boolean; value?: number; error?: string } {
  if (typeof value !== "number") {
    return { valid: false, error: `${fieldName} must be a number, got ${typeof value}` };
  }
  if (Number.isNaN(value)) {
    return { valid: false, error: `${fieldName} is NaN` };
  }
  if (!Number.isFinite(value)) {
    return { valid: false, error: `${fieldName} is not finite (got ${value})` };
  }
  return { valid: true, value };
}

/**
 * Validates signal payload against strict schema rules.
 * Returns {valid, errors} for fail-fast inspection.
 * NO THROWING — explicit error collection only.
 */
export function validateSignalPayload(payload: unknown): ValidationResult {
  const errors: string[] = [];

  if (!payload || typeof payload !== "object") {
    return { valid: false, errors: ["Payload must be a non-null object"] };
  }

  const p = payload as Record<string, unknown>;

  // Check for unknown keys
  const allowedKeys = new Set(["symbol", "direction", "state", "entry_price", "stop_loss", "take_profit", "confidence", "breakout_level"]);
  const unknownKeys = Object.keys(p).filter(k => !allowedKeys.has(k));
  if (unknownKeys.length > 0) {
    errors.push(`Unknown fields: ${unknownKeys.join(", ")}`);
  }

  // Validate required fields
  if (!p.symbol || typeof p.symbol !== "string") {
    errors.push("Missing or invalid 'symbol' (must be string)");
  }
  if (!p.direction || !ALLOWED_DIRECTIONS.includes(p.direction as any)) {
    errors.push(`Invalid 'direction': ${p.direction}. Must be LONG or SHORT`);
  }
  if (!p.state || !ALLOWED_STATES.includes(p.state as any)) {
    errors.push(`Invalid 'state': ${p.state}. Must be EARLY_OPEN, CONFIRMED, or END`);
  }

  // Strict numeric sanitization
  const entryPriceSanitized = sanitizeNumeric(p.entry_price, "entry_price");
  if (!entryPriceSanitized.valid) {
    errors.push(entryPriceSanitized.error!);
  }

  const stopLossSanitized = sanitizeNumeric(p.stop_loss, "stop_loss");
  if (!stopLossSanitized.valid) {
    errors.push(stopLossSanitized.error!);
  }

  const takeProfitSanitized = sanitizeNumeric(p.take_profit, "take_profit");
  if (!takeProfitSanitized.valid) {
    errors.push(takeProfitSanitized.error!);
  }

  const breakoutLevelSanitized = sanitizeNumeric(p.breakout_level, "breakout_level");
  if (!breakoutLevelSanitized.valid) {
    errors.push(breakoutLevelSanitized.error!);
  }

  // Confidence must be 0-100
  const confidenceSanitized = sanitizeNumeric(p.confidence, "confidence");
  if (!confidenceSanitized.valid) {
    errors.push(confidenceSanitized.error!);
  } else if (confidenceSanitized.value! < 0 || confidenceSanitized.value! > 100) {
    errors.push(`confidence out of range: ${confidenceSanitized.value} (must be 0-100)`);
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, errors: [] };
}

/**
 * Pre-insert lifecycle logging: Stage 1 PAYLOAD GENERATION
 */
export function logSignalGenerated(symbol: string, direction: string, score: number): void {
  console.log(`[1] SIGNAL GENERATED | ${symbol} | ${direction} | score: ${score}`);
}

/**
 * Pre-insert lifecycle logging: Stage 2 PAYLOAD SERIALIZED
 */
export function logPayloadSerialized(payload: SignalInsert): void {
  console.log(
    `[2] PAYLOAD SERIALIZED | ${payload.symbol} | ${payload.state} | ${payload.direction} | ` +
    `entry: $${payload.entry_price.toFixed(2)} | SL: $${payload.stop_loss.toFixed(2)} | TP: $${payload.take_profit.toFixed(2)} | conf: ${payload.confidence}%`
  );
}

/**
 * Pre-insert lifecycle logging: Stage 3 VALIDATION PASSED
 */
export function logValidationPassed(symbol: string): void {
  console.log(`[3] VALIDATION PASSED | ${symbol}`);
}

/**
 * Pre-insert lifecycle logging: Stage 4 INSERT ATTEMPTED
 */
export function logInsertAttempted(symbol: string): void {
  console.log(`[4] INSERT ATTEMPTED | ${symbol}`);
}

/**
 * Pre-insert lifecycle logging: Stage 5 INSERT SUCCESS
 */
export function logInsertSuccess(symbol: string, signalId: number): void {
  console.log(`[5] INSERT SUCCESS | ${symbol} | signal_id: ${signalId}`);
}

/**
 * Structured error logging for validation failures.
 */
export function logValidationFailed(reason: string, payload: unknown): void {
  console.error(`[VALIDATION FAILED] ${reason}`, {
    payload: typeof payload === "object" && payload !== null ? (payload as any).symbol : "unknown",
  });
}

/**
 * Structured error logging for insert failures.
 */
export function logInsertFailed(error: string, payload: SignalInsert): void {
  console.error(`[INSERT FAILED] ${error}`, {
    symbol: payload.symbol,
    direction: payload.direction,
    state: payload.state,
    entry_price: payload.entry_price,
  });
}

/**
 * Post-insert verification logging: Stage 6 DB VERIFIED
 */
export function logDbVerified(symbol: string, signalId: number, state: string): void {
  console.log(`[6] DB VERIFIED | ${symbol} | signal_id: ${signalId} | state: ${state}`);
}
