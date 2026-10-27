# CX Switch Redis provider migration (Layerbase → Upstash)

## Safety rule

Do not change Vercel Production variables, merge this preparation branch, or point production at the replacement until the source export has been obtained and the isolated restore has passed validation. The Layerbase source may be paused and unavailable over REST; an export from its dashboard is the source-of-truth input.

## 1. Provision a destination

1. Create a Redis database in Upstash: https://console.upstash.com/redis
2. Select a region close to the Vercel deployment and use the REST API endpoint/token.
3. Keep the destination credentials private. Never use a `NEXT_PUBLIC_` variable for Redis credentials.
4. Start with the free plan only if its current command, bandwidth and storage quotas fit measured CX Switch usage. Set a usage alert where available.

## 2. Capture and preserve the source

1. Export the complete Layerbase Redis database using the Layerbase dashboard export facility.
2. Preserve an immutable original export and work only from a copy.
3. Record export timestamp, file size and SHA-256 checksum.
4. Inspect the export format and confirm it includes all persistent keys, especially:
   - `cxswitch:active_signals`
   - `cxswitch:signal_history` (retain the latest 50 entries)
   - `cxswitch:latest_alerts`
   - `cxswitch:cooldowns`, `cxswitch:exit_alert_cooldowns`
   - `cxswitch:card_resets`
   - `cxswitch:last_cron`
   - `cxswitch:v28_breakout_state`
   - one-time cleanup/migration markers and any other `cxswitch:` keys
5. Do not import transient cron locks or short-lived Telegram dedupe keys as live locks. Preserve a raw copy of them in the original export for audit purposes, but omit expired/transient keys from the restored live dataset.

If Layerbase cannot export while paused, stop here and contact Layerbase support for a temporary restore/export. Do not infer missing state from an older Supabase backup or silently start with empty state.

## 3. Restore to the isolated destination

Use a one-off local migration utility or Redis-compatible importer; do not add an unauthenticated import endpoint to the deployed app. Keep credentials in local environment variables and never commit them.

- Preserve each key's exact name and value semantics. The current application JSON-serializes values before issuing Redis `SET`; imported JSON values must remain strings encoded the same way.
- Preserve remaining TTLs for keys that had expirations. Do not restore already-expired keys.
- Exclude stale cron/migration locks and expired Telegram dedupe keys.
- Set `cxswitch:migrated_to_layerbase_v1` to a verified migration record **only after** required data has been restored and checked. This prevents `runMigrationIfNeeded()` from trying to bootstrap from the legacy Supabase KV source and overwriting the restored destination.
- Verify the active-signals array and history array exist and decode correctly. Compare all restored keys/values with the working export and record any intentionally omitted transient keys.

## 4. Configure an isolated Preview

Set these variables only on a dedicated Preview branch/environment in Vercel:

- `REDIS_REST_URL`: Upstash REST endpoint
- `REDIS_REST_TOKEN`: Upstash REST token (encrypted/sensitive)

The existing `lib/supabase-kv.ts` adapter uses this REST URL/token pair and supports the Redis commands needed by the state layer. Its filename is historical; do not change state call sites just to change provider.

Never add these variables to Production during this phase. Ensure the Preview deployment is pointed only at the test database.

## 5. Required acceptance tests

- GET/SET round-trip for strings, arrays, objects, booleans and null-like values.
- TTL behaviour and expiry.
- Atomic `SET ... NX EX` cron-lock claim.
- Lua compare-and-delete releases only the matching token and cannot delete another run's lock.
- Alert deduplication `SET NX EX` behaviour.
- Active positions, latest alerts, cooldowns, card resets, breakout state and last-cron timestamp match the source snapshot.
- Signal history decodes and contains no more than the latest 50 entries.
- Run a non-production controlled scan across BTC, ETH, SOL, HYPE, DOGE, LINK, VIRTUAL and ZEC. Confirm writes persist across separate requests and logs show no Redis errors.
- Observe usage and latency across multiple scheduled test runs; check for any duplicate scan/alert behaviour.

A Preview build alone is not proof of database migration. Attach a redacted test report with counts, key names, TTL checks and pass/fail results; never include credentials or full trade payloads.

## 6. Production cutover and rollback

Only after acceptance tests pass:

1. Arrange a short write freeze so state cannot diverge during the final reconciliation.
2. Obtain a final source export if Layerbase permits it; reconcile changes since the initial export.
3. Take a fresh destination backup/export.
4. Update Production `REDIS_REST_URL` and `REDIS_REST_TOKEN` together, then deploy.
5. Verify the first real cron run, lock release, dashboard state, alert idempotency and state persistence.
6. Keep the old source/export and rollback notes until production has remained healthy through several scheduled cycles.

Rollback means restoring the last known-good production deployment and credentials/database pairing. Never point code at a different Redis database without first checking that its state is current. Do not delete the Layerbase database or its export during the rollback window.

## Known caveat

The Upstash free tier is quota-limited and should not be treated as an uptime SLA. Monitor command count, bandwidth, storage and errors. Do not create artificial polling traffic to work around a provider's free-tier policy.
