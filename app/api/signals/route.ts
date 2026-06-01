import { kv } from "@vercel/kv";

export const runtime = "nodejs";

export async function GET() {
  const data = await kv.get("cx:snapshots");

  return Response.json({
    signals: Array.isArray(data) ? data : [],
    updatedAt: new Date().toISOString(),
  });
}
