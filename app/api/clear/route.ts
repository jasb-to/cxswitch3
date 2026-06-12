// app/api/clear/route.ts
// v13: Manual KV clear — uses Upstash REST API (no npm package needed)
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL!;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN!;

async function kvDel(key: string) {
  const res = await fetch(`${UPSTASH_REDIS_REST_URL}/del/${key}`, {
    headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
  });
  return res.json();
}

export async function GET() {
  await kvDel('signals');
  await kvDel('market_data');
  await kvDel('active_trades');
  return Response.json({ cleared: true });
}
