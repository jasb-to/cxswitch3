export interface SignalSnapshot {
  symbol: string;

  isSetupValid: boolean;
  isSniper: boolean;

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

export interface TelegramCooldown {
  symbol: string;
  lastAlertAt: string;
}

/* =========================
   IN-MEMORY STATE
========================= */

const signalSnapshots = new Map<string, SignalSnapshot>();
const telegramCooldowns = new Map<string, TelegramCooldown>();

console.log("[PERSISTENCE] initialized");

/* =========================
   HELPERS (SAFE NORMALISATION)
========================= */

function safeNumber(value: any, fallback = 0): number {
  return typeof value === "number" && isFinite(value)
    ? value
    : fallback;
}

function safeSnapshot(snapshot: SignalSnapshot): SignalSnapshot {
  return {
    symbol: snapshot.symbol,

    isSetupValid: !!snapshot.isSetupValid,
    isSniper: !!snapshot.isSniper,

    confidence: safeNumber(snapshot.confidence, 0),

    price: safeNumber(snapshot.price, 0),

    adx: safeNumber(snapshot.adx, 0),
    stochK: safeNumber(snapshot.stochK, 0),
    stochD: safeNumber(snapshot.stochD, 0),

    bias: snapshot.bias ?? "Neutral",
    reason: snapshot.reason ?? "UNKNOWN",

    stopLoss: snapshot.stopLoss ?? null,
    takeProfit: snapshot.takeProfit ?? null,
    riskRewardRatio: snapshot.riskRewardRatio ?? null,

    updatedAt: snapshot.updatedAt ?? new Date().toISOString(),
  };
}

/* =========================
   SNAPSHOTS
========================= */

export async function storeSignalSnapshot(snapshot: SignalSnapshot) {
  const safe = safeSnapshot(snapshot);

  signalSnapshots.set(safe.symbol, safe);

  const status = safe.isSniper
    ? "🟢 SNIPER"
    : safe.isSetupValid
    ? "🟡 SETUP"
    : "🔵 EARLY/NO_SETUP";

  console.log(
    `[PERSISTENCE] ${safe.symbol}: ${status} | price=$${safe.price}`
  );
}

export async function getLatestSignalSnapshots(): Promise<
  SignalSnapshot[]
> {
  const values = Array.from(signalSnapshots.values());

  // IMPORTANT: always guarantee output shape stability
  return ["BTC", "ETH", "SOL"].map((symbol) => {
    const found = values.find((s) => s.symbol === symbol);

    if (found) return safeSnapshot(found);

    // fallback placeholder prevents UI crashes
    return {
      symbol,
      isSetupValid: false,
      isSniper: false,
      confidence: 0,
      price: 0,
      adx: 0,
      stochK: 0,
      stochD: 0,
      bias: "Neutral",
      reason: "NO_DATA",
      stopLoss: null,
      takeProfit: null,
      riskRewardRatio: null,
      updatedAt: new Date().toISOString(),
    };
  });
}

/* =========================
   TELEGRAM COOLDOWN
========================= */

export async function getTelegramCooldown(
  symbol: string
): Promise<TelegramCooldown | null> {
  return telegramCooldowns.get(symbol) ?? null;
}

export async function updateTelegramCooldown(
  symbol: string,
  timestamp: string
) {
  telegramCooldowns.set(symbol, {
    symbol,
    lastAlertAt: timestamp,
  });

  console.log(
    `[PERSISTENCE] cooldown updated ${symbol} @ ${timestamp}`
  );
}
