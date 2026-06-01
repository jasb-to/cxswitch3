import { promises as fs } from "fs";
import path from "path";

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

const FILE_PATH = path.join("/tmp", "signals.json");

/* =========================
   LOAD
========================= */
async function load(): Promise<SignalSnapshot[]> {
  try {
    const data = await fs.readFile(FILE_PATH, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

/* =========================
   SAVE
========================= */
async function save(data: SignalSnapshot[]) {
  await fs.writeFile(FILE_PATH, JSON.stringify(data, null, 2));
}

/* =========================
   STORE SNAPSHOT
========================= */
export async function storeSignalSnapshot(snapshot: SignalSnapshot) {
  const all = await load();

  const filtered = all.filter((s) => s.symbol !== snapshot.symbol);
  filtered.push(snapshot);

  await save(filtered);

  console.log(
    `[PERSISTENCE] ${snapshot.symbol} stored @ ${snapshot.price}`
  );
}

/* =========================
   GET LATEST
========================= */
export async function getLatestSignalSnapshots() {
  return await load();
}
