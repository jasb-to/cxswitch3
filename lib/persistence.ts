import { kvGet, kvSet } from "./kv";
import type { Signal } from "./strategy";

export async function storeSignalSnapshot(snapshot: Signal) {
  if (!snapshot?.symbol || typeof snapshot.price !== "number") {
    console.log("[KV REJECT]", snapshot);
    return;
  }

  const key = `signals:${snapshot.symbol}`;

  const existing = await kvGet(key);

  const history = existing?.result
    ? JSON.parse(existing.result)
    : [];

  history.push(snapshot);

  if (history.length > 50) history.shift();

  await kvSet(key, JSON.stringify(history));

  console.log("[KV WRITE]", snapshot.symbol, snapshot.price);
}

export async function getLatestSignalSnapshots() {
  const symbols = ["BTC", "ETH", "SOL"];

  const results: Signal[] = [];

  for (const symbol of symbols) {
    const data = await kvGet(`signals:${symbol}`);

    const parsed = data?.result
      ? JSON.parse(data.result)
      : [];

    if (parsed.length > 0) {
      results.push(parsed[parsed.length - 1]);
    }
  }

  return results;
}
