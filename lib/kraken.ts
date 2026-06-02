export type Symbol = "BTC" | "ETH" | "SOL";

function mapSymbol(symbol: Symbol) {
  switch (symbol) {
    case "BTC":
      return "XXBTZUSD"; // BTC/USD
    case "ETH":
      return "XETHZUSD"; // ETH/USD
    case "SOL":
      return "SOLUSD"; // SOL/USD (Kraken native spot pair)
    default:
      throw new Error(`Unsupported symbol: ${symbol}`);
  }
}
