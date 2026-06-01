import { kvGet, kvSet } from "./kv";

export interface SignalSnapshot {
  symbol: string;
  isEarly: boolean;
  isSniper: boolean;
  isActive: boolean;

  confidence: number;
  price: number;

  adx: number;
  stochK: number;
  stochD: number;

  bias: "Bullish" | "Bearish" | "Neutral";
  reason: string;

  stopLoss: number | null;
  takeProfit: number | null;
  riskRewardRatio: number | null;

  updatedAt: string;
}

/* =========================
   STORE SNAPSHOT
========================= */

export async function storeSignalSnapshot(snapshot: SignalSnapshot) {
  const key = `signals:${snapshot.symbol}`;

  const existing = await kvGet(key);

  // Upstash returns: { result: "..." }
  const parsedExisting = existing?.result
    ? JSON.parse(existing.result)
    : [];

  const updated = [...parsedExisting, snapshot];

  if (updated.length > 50) updated.shift();

  await kvSet(key, JSON.stringify(updated));

  console.log(
    `[KV] ${snapshot.symbol}: ${snapshot.price} | ${snapshot.reason}`
  );
}

/* =========================
   GET LATEST SNAPSHOTS
========================= */

export async function getLatestSignalSnapshots() {
  const symbols = ["BTC", "ETH", "SOL"];

  const results = [];

  for (const symbol of symbols) {
    const data = await kvGet(`signals:${symbol}`);

    const parsed = data?.result ? JSON.parse(data.result) : [];

    if (parsed.length > 0) {
      results.push(parsed[parsed.length - 1]);
    }
  }

  return results;
}
