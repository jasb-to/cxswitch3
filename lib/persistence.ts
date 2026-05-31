import fs from "fs";
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

const FILE_PATH = path.join(process.cwd(), "signal-store.json");

/* =========================
   LOAD STORE
========================= */
function loadStore(): Record<string, SignalSnapshot[]> {
  try {
    if (!fs.existsSync(FILE_PATH)) return {};
    return JSON.parse(fs.readFileSync(FILE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

/* =========================
   SAVE STORE
========================= */
function saveStore(data: Record<string, SignalSnapshot[]>) {
  fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2));
}

/* =========================
   STORE SNAPSHOT
========================= */
export async function storeSignalSnapshot(snapshot: SignalSnapshot) {
  const store = loadStore();

  if (!store[snapshot.symbol]) {
    store[snapshot.symbol] = [];
  }

  store[snapshot.symbol].push(snapshot);

  if (store[snapshot.symbol].length > 50) {
    store[snapshot.symbol].shift();
  }

  saveStore(store);

  console.log(
    `[PERSISTENCE] ${snapshot.symbol}: ${
      snapshot.isSniper ? "🟢 SNIPER" : snapshot.isEarly ? "🟣 EARLY" : "⚪ WAIT"
    } | $${snapshot.price}`
  );
}

/* =========================
   GET LATEST SNAPSHOTS
========================= */
export async function getLatestSignalSnapshots(): Promise<
  SignalSnapshot[]
> {
  const store = loadStore();

  return Object.values(store)
    .map((arr) => arr[arr.length - 1])
    .filter(Boolean);
}
