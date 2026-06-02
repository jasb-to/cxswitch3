const lastAlertState: Record<string, string> = {};

export function shouldAlert(symbol: string, state: string) {
  const key = symbol;
  const prev = lastAlertState[key];

  if (prev === state) return false;

  lastAlertState[key] = state;
  return true;
}
