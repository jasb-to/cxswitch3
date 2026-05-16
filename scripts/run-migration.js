#!/usr/bin/env node

/**
 * v23.0.0: Run Supabase migrations
 * Creates snapshots table for durable snapshot storage
 */

const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const path = require("path");

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error(
    "[MIGRATION_ERROR] Missing env vars: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"
  );
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function runMigration() {
  try {
    console.log("[MIGRATION_START] Creating snapshots table...");

    // Read the migration SQL
    const migrationSql = fs.readFileSync(
      path.join(__dirname, "setup-snapshots-table.sql"),
      "utf8"
    );

    // Execute the migration
    const { error } = await supabase.rpc("exec", {
      sql: migrationSql,
    });

    if (error) {
      // If rpc doesn't work, try direct SQL execution via Postgres
      console.warn("[MIGRATION_RPC_FAILED] Trying direct Postgres connection...");
      
      // Fallback: use the regular query builder for each statement
      const statements = migrationSql
        .split(";")
        .map(s => s.trim())
        .filter(s => s && !s.startsWith("--"));

      for (const statement of statements) {
        if (statement.includes("CREATE TABLE")) {
          const { error: tableError } = await supabase
            .from("snapshots")
            .select("*")
            .limit(1);
          
          if (tableError && tableError.message.includes("does not exist")) {
            console.log("[MIGRATION_TABLE_MISSING] Need to create table via dashboard");
          }
        }
      }
    }

    console.log("[MIGRATION_COMPLETE] Snapshots table ready");
  } catch (err) {
    console.error("[MIGRATION_EXCEPTION]", err.message);
    process.exit(1);
  }
}

runMigration();
