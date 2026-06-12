// app/api/clear/route.ts
import { kv } from '@vercel/kv';

export async function GET() {
  await kv.del('signals');
  await kv.del('market_data');
  await kv.del('active_trades');
  return Response.json({ cleared: true });
}
