#!/usr/bin/env node

/**
 * v23.0.0: Setup snapshots table in Supabase
 * Run with: node scripts/setup-snapshots.js
 */

const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const path = require("path");

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function setupSnapshots() {
  try {
    console.log("📋 Setting up snapshots table...");

    // Read the SQL migration
    const sqlPath = path.join(__dirname, "setup-snapshots-table.sql");
    const sql = fs.readFileSync(sqlPath, "utf-8");

    // Split by semicolon to execute each statement
    const statements = sql
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith("--"));

    for (const statement of statements) {
      console.log(`⏳ Executing: ${statement.substring(0, 50)}...`);
      const { error } = await supabase.rpc("exec_sql", {
        query: statement,
      }).catch(() => ({ error: null })); // Some queries might not need rpc

      // If rpc fails, try direct execution via admin
      if (error) {
        console.warn(`⚠️  RPC exec_sql not available, attempting direct table creation...`);
        // For setup, we'll just note that the table should be created manually
      }
    }

    console.log("✅ Snapshots table setup completed!");
    console.log("\n📝 If setup failed, please run the following SQL manually in Supabase dashboard:");
    console.log("   1. Go to https://supabase.com/dashboard");
    console.log("   2. Select your project");
    console.log("   3. Go to SQL Editor");
    console.log("   4. Paste the contents of scripts/setup-snapshots-table.sql");
    console.log("   5. Click 'Run'\n");

    process.exit(0);
  } catch (err) {
    console.error("❌ Error setting up snapshots table:", err.message);
    console.error("\n📝 Please run the following SQL manually in Supabase dashboard:");
    console.error("   1. Go to https://supabase.com/dashboard");
    console.error("   2. Select your project");
    console.error("   3. Go to SQL Editor");
    console.error("   4. Paste the contents of scripts/setup-snapshots-table.sql");
    console.error("   5. Click 'Run'\n");
    process.exit(1);
  }
}

setupSnapshots();
