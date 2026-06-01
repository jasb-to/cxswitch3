const BASE_URL = process.env.KV_REST_API_URL!;
const TOKEN = process.env.KV_REST_API_TOKEN!;

async function kvFetch(path: string, body?: any) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[KV ERROR] ${res.status}: ${text}`);
  }

  return res.json();
}

/* =========================
   KV OPERATIONS
========================= */

export async function kvGet(key: string) {
  return kvFetch(`/get/${key}`);
}

export async function kvSet(key: string, value: any) {
  return kvFetch(`/set/${key}`, value);
}
