// lib/clear-on-deploy.ts
// v13: Auto-clear KV on deploy — add to layout.tsx or root page
import { kv } from '@vercel/kv';

let cleared = false;

export async function clearKVOnDeploy() {
  if (cleared) return;
  cleared = true;
  try {
    await kv.del('signals');
    await kv.del('market_data');
    await kv.del('active_trades');
    console.log('[DEPLOY] KV cleared on deploy');
  } catch (e) {
    console.error('[DEPLOY] KV clear failed:', e);
  }
}
