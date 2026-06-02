export const KRAKEN_BASE = "https://api.kraken.com/0/public";

export type Symbol = "BTC" | "ETH" | "SOL";

function mapSymbol(symbol: Symbol) {
  switch (symbol) {
    case "BTC":
      return "XXBTZUSD";
    case "ETH":
      return "XETHZUSD";
    case "SOL":
      return "SOLUSD";
    default:
      throw new Error(`Unsupported symbol: ${symbol}`);
  }
}

async function fetchKraken(url: string) {
  try {
    const res = await fetch(url);

    if (!res.ok) return null;

    const data = await res.json();

    if (data?.error?.length) return null;

    return data.result;
  } catch {
    return null;
  }
}

export async function getCurrentPrice(symbol: Symbol): Promise<number> {
  const pair = mapSymbol(symbol);

  const url = `${KRAKEN_BASE}/Ticker?pair=${pair}`;

  const result = await fetchKraken(url);

  if (!result) return 0;

  const key = Object.keys(result)[0];
  const price = result?.[key]?.c?.[0];

  const parsed = Number(price);

  if (!parsed || isNaN(parsed)) return 0;

  return parsed;
}
