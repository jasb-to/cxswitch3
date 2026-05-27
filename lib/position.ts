export interface Position {
  direction: "LONG" | "SHORT";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  enteredAt: number;
}

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(command: string[]): Promise<any> {
  if (!REDIS_URL || !REDIS_TOKEN) {
    console.warn("[POSITION] Redis not configured, using memory fallback");
    return null;
  }

  try {
    const response = await fetch(`${REDIS_URL}/exec`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ commands: [command] }),
    });

    const data = await response.json();
    return data.result?.[0];
  } catch (err) {
    console.error("[POSITION] Redis error:", err);
    return null;
  }
}

// Get active position for symbol
export async function getPosition(symbol: string): Promise<Position | null> {
  try {
    const key = `position:${symbol}`;
    const data = await redis(["GET", key]);
    return data ? (JSON.parse(data as string) as Position) : null;
  } catch (err) {
    console.error(`[POSITION] Error getting position for ${symbol}:`, err);
    return null;
  }
}

// Set position with 24h TTL
export async function setPosition(symbol: string, position: Position): Promise<void> {
  try {
    const key = `position:${symbol}`;
    await redis(["SETEX", key, "86400", JSON.stringify(position)]); // 24h TTL
    console.log(`[POSITION] Set position for ${symbol}: ${position.direction}`);
  } catch (err) {
    console.error(`[POSITION] Error setting position for ${symbol}:`, err);
  }
}

// Delete position
export async function deletePosition(symbol: string): Promise<void> {
  try {
    const key = `position:${symbol}`;
    await redis(["DEL", key]);
    console.log(`[POSITION] Deleted position for ${symbol}`);
  } catch (err) {
    console.error(`[POSITION] Error deleting position for ${symbol}:`, err);
  }
}

// Set cooldown for 15 minutes
export async function setCooldown(symbol: string): Promise<void> {
  try {
    const key = `cooldown:${symbol}`;
    await redis(["SETEX", key, "900", "1"]); // 15 minutes TTL
    console.log(`[POSITION] Cooldown set for ${symbol}`);
  } catch (err) {
    console.error(`[POSITION] Error setting cooldown for ${symbol}:`, err);
  }
}

// Check if cooldown active
export async function isCooldownActive(symbol: string): Promise<boolean> {
  try {
    const key = `cooldown:${symbol}`;
    const data = await redis(["GET", key]);
    return data !== null;
  } catch (err) {
    console.error(`[POSITION] Error checking cooldown for ${symbol}:`, err);
    return false;
  }
}
