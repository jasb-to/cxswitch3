import { createHash, createHmac } from "crypto";

const API_KEY = process.env.KRAKEN_API_KEY || "";
const API_SECRET = process.env.KRAKEN_API_SECRET || "";

export async function placeOrder(params: {
  pair: string;
  type: "buy" | "sell";
  ordertype: string;
  volume: string;
}) {
  if (!API_KEY || !API_SECRET) {
    throw new Error("Kraken API credentials not configured");
  }

  const nonce = Date.now() * 1000;
  const body = new URLSearchParams({ ...params, nonce: nonce.toString() });

  const path = "/0/private/AddOrder";
  const message = nonce + body.toString();

  const signature = createHmac("sha512", Buffer.from(API_SECRET, "base64"))
    .update(path + createHash("sha256").update(message).digest("hex"), "hex")
    .digest("base64");

  const res = await fetch("https://api.kraken.com/0/private/AddOrder", {
    method: "POST",
    headers: {
      "API-Key": API_KEY,
      "API-Sign": signature,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const data = await res.json();
  if (data.error?.length) throw new Error(data.error.join(", "));

  return { txid: data.result.txid[0] };
}
