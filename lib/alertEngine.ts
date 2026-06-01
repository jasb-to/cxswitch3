let lastState: Record<string, string> = {};

export function detectAlerts(signals: any[]) {
  const alerts: any[] = [];

  for (const s of signals) {
    const prev = lastState[s.symbol];

    // 🔥 ONLY FIRE WHEN ENTERING SNIPER
    if (s.state === "SNIPER" && prev !== "SNIPER") {
      alerts.push({
        symbol: s.symbol,
        type: "SNIPER_ENTRY",
        price: s.price,
        message: `🔥 SNIPER ENTRY: ${s.symbol} @ ${s.price}`,
      });
    }

    lastState[s.symbol] = s.state;
  }

  return alerts;
}
