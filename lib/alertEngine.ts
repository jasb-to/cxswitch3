let lastState: Record<string, string> = {};

export function detectAlerts(signals: any[]) {
  const alerts: any[] = [];

  for (const s of signals) {
    if (!s?.symbol) continue;

    const prev = lastState[s.symbol];

    if (s.state === "SNIPER" && prev !== "SNIPER") {
      alerts.push({
        symbol: s.symbol,
        type: "SNIPER_ENTRY",
        message: `🔥 SNIPER: ${s.symbol} @ ${s.price}`,
      });
    }

    lastState[s.symbol] = s.state;
  }

  return alerts;
}
