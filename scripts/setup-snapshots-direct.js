#!/usr/bin/env node

/**
 * v23.0.0: Direct Supabase snapshots table creation
 * Uses Supabase admin API to create table if it doesn't exist
 */

const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error(
    "[SETUP_ERROR] Missing: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY"
  );
  process.exit(1);
}

async function setupSnapshots() {
  try {
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log("[SETUP] Checking if snapshots table exists...");

    // Try to query the table to see if it exists
    const { data, error } = await supabase
      .from("snapshots")
      .select("*", { count: "exact", head: true })
      .limit(1);

    if (!error) {
      console.log("[SETUP_OK] Snapshots table already exists");
      return;
    }

    if (!error.message.includes("does not exist")) {
      console.error("[SETUP_ERROR] Unexpected error:", error.message);
      return;
    }

    console.log("[SETUP] Table does not exist. Creating via SQL...");

    // Create the table using raw SQL via the SQL endpoint
    const fs = require("fs");
    const path = require("path");
    const migrationSql = fs.readFileSync(
      path.join(__dirname, "setup-snapshots-table.sql"),
      "utf8"
    );

    // Try using the query method with raw SQL
    const { error: createError } = await supabase.rpc("execute_sql", {
      sql: migrationSql,
    });

    if (!createError) {
      console.log("[SETUP_COMPLETE] Snapshots table created successfully");
      return;
    }

    // Fallback: show instructions for manual creation
    console.warn("[SETUP_MANUAL_REQUIRED] Unable to auto-create table");
    console.warn("Please run this SQL in Supabase dashboard:");
    console.warn(migrationSql);

  } catch (err) {
    console.error("[SETUP_EXCEPTION]", err.message);
  }
}

setupSnapshots();
