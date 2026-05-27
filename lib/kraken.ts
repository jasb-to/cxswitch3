/**
 * KRAKEN TRADE EXECUTION
 * Minimal interface to Kraken private API for placing market orders
 */

import crypto from "crypto";

const KRAKEN_API_URL = "https://api.kraken.com";
const API_KEY = process.env.KRAKEN_API_KEY || "";
const API_SECRET = process.env.KRAKEN_API_SECRET || "";

export interface OrderRequest {
  pair: string; // e.g., "XXBTZUSD"
  type: "buy" | "sell";
  ordertype: "market";
  volume: string; // e.g., "0.001"
}

export interface OrderResponse {
  ok: boolean;
  orderId?: string;
  error?: string;
}

/**
 * Generate Kraken API signature for private endpoints
 */
function getKrakenSignature(path: string, data: Record<string, string>, secret: string): string {
  const message = new URLSearchParams(data).toString();
  const pathHash = crypto.createHash("sha256").update(message).digest();
  const signature = crypto
    .createHmac("sha512", Buffer.from(secret, "base64"))
    .update(path + pathHash)
    .digest("base64");
  return signature;
}

/**
 * Place a market order on Kraken
 * Minimum volumes: 0.001 BTC, 0.01 ETH, 0.1 SOL
 */
export async function executeKrakenOrder(order: OrderRequest): Promise<OrderResponse> {
  try {
    const nonce = Date.now().toString();
    const path = "/0/private/AddOrder";
    const endpoint = KRAKEN_API_URL + path;

    const data: Record<string, string> = {
      nonce,
      ordertype: order.ordertype,
      type: order.type,
      volume: order.volume,
      pair: order.pair,
    };

    const signature = getKrakenSignature(path, data, API_SECRET);

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "API-Key": API_KEY,
        "API-Sign": signature,
      },
      body: new URLSearchParams(data),
    });

    const result = await response.json();

    if (result.error && result.error.length > 0) {
      console.error("[KRAKEN] Order failed:", result.error);
      return {
        ok: false,
        error: result.error[0],
      };
    }

    const orderId = result.result?.txid?.[0];
    console.log(`[KRAKEN] Order placed: ${order.type} ${order.volume} ${order.pair} (${orderId})`);

    return {
      ok: true,
      orderId,
    };
  } catch (err) {
    console.error("[KRAKEN] Exception:", err);
    return {
      ok: false,
      error: String(err),
    };
  }
}

/**
 * Check if we already have an open position for a symbol
 * Returns true if we have any open orders or positions
 */
export async function checkPosition(symbol: string): Promise<boolean> {
  try {
    const nonce = Date.now().toString();
    const path = "/0/private/OpenOrders";
    const endpoint = KRAKEN_API_URL + path;

    const data: Record<string, string> = {
      nonce,
    };

    const signature = getKrakenSignature(path, data, API_SECRET);

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "API-Key": API_KEY,
        "API-Sign": signature,
      },
      body: new URLSearchParams(data),
    });

    const result = await response.json();

    if (result.error && result.error.length > 0) {
      console.warn("[KRAKEN] Could not check position:", result.error);
      return false;
    }

    // Check if any open orders contain our symbol
    const orders = result.result || {};
    for (const orderId in orders) {
      const order = orders[orderId];
      if (order.info && order.info.includes(symbol)) {
        return true;
      }
    }

    return false;
  } catch (err) {
    console.warn("[KRAKEN] Exception checking position:", err);
    return false;
  }
}
