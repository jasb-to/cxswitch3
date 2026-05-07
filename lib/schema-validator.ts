/**
 * Schema Validator - Startup Check (v2.7.4)
 * 
 * Verifies database constraints are correct before signal engine starts.
 * FAILS startup immediately if schema is misaligned.
 */

import { supabase } from "@/lib/supabase-client";

export type SchemaValidationResult = {
  valid: boolean;
  errors: string[];
  constraint?: string;
};

/**
 * Validates signals table constraint on startup.
 * MUST contain EARLY_OPEN. Fails if EARLY still exists.
 */
export async function validateSignalSchema(): Promise<SchemaValidationResult> {
  const errors: string[] = [];

  try {
    // Query the actual constraint from live database
    const { data, error } = await supabase.rpc("get_constraint_def", {
      table_name: "signals",
      constraint_name: "signals_state_check",
    });

    if (error) {
      console.error("[SCHEMA VALIDATOR] Failed to query constraint:", error.message);
      errors.push(`Failed to query constraint: ${error.message}`);
      return { valid: false, errors };
    }

    const constraintDef = data as string | null;

    if (!constraintDef) {
      errors.push("signals_state_check constraint not found");
      return { valid: false, errors };
    }

    // Check for required states
    const hasEarlyOpen = constraintDef.includes("EARLY_OPEN");
    const hasConfirmed = constraintDef.includes("CONFIRMED");
    const hasEnd = constraintDef.includes("END");
    const hasLegacyEarly = constraintDef.includes("'EARLY'") && !constraintDef.includes("EARLY_OPEN");

    if (hasLegacyEarly) {
      errors.push("[FATAL] Supabase schema still using legacy EARLY state — constraint repair required");
    }

    if (!hasEarlyOpen) {
      errors.push("Constraint missing EARLY_OPEN state");
    }
    if (!hasConfirmed) {
      errors.push("Constraint missing CONFIRMED state");
    }
    if (!hasEnd) {
      errors.push("Constraint missing END state");
    }

    if (errors.length > 0) {
      return { valid: false, errors, constraint: constraintDef };
    }

    console.log("[SCHEMA VALIDATOR] ✓ Schema valid — constraint includes EARLY_OPEN, CONFIRMED, END");
    return { valid: true, errors: [], constraint: constraintDef };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    errors.push(`Exception: ${reason}`);
    return { valid: false, errors };
  }
}

/**
 * Run schema validation on startup. Blocks signal engine if schema is invalid.
 */
export async function startupSchemaCheck() {
  console.log("[STARTUP] Validating database schema...");

  const result = await validateSignalSchema();

  if (!result.valid) {
    console.error("[FATAL] Schema validation failed:");
    for (const error of result.errors) {
      console.error(`  - ${error}`);
    }
    console.error("[FATAL] Signal engine BLOCKED — resolve schema before deployment");
    process.exit(1);
  }

  console.log("[STARTUP] Schema validation passed");
}
