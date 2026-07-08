// Global application state tracking (in-memory for Vercel serverless)

export interface HistoryStatus {
  required: number;
  available: number;
  ready: boolean;
}

export interface PairStatus {
  pair: string;
  historyStatus: HistoryStatus;
  lastUpdated: number;
}

export interface AppState {
  pairs: Record<string, PairStatus>;
  lastCronRun: number;
}

// In-memory state (resets on deployment, restored via cron checks)
let appState: AppState = {
  pairs: {
    BTC: { pair: "BTC", historyStatus: { required: 350, available: 0, ready: false }, lastUpdated: 0 },
    ETH: { pair: "ETH", historyStatus: { required: 350, available: 0, ready: false }, lastUpdated: 0 },
    SOL: { pair: "SOL", historyStatus: { required: 350, available: 0, ready: false }, lastUpdated: 0 },
    HYPE: { pair: "HYPE", historyStatus: { required: 350, available: 0, ready: false }, lastUpdated: 0 },
  },
  lastCronRun: 0,
};

export function getAppState(): AppState {
  return appState;
}

export function updateHistoryStatus(pair: string, available: number): void {
  if (!appState.pairs[pair]) {
    appState.pairs[pair] = { pair, historyStatus: { required: 350, available: 0, ready: false }, lastUpdated: 0 };
  }
  appState.pairs[pair].historyStatus = {
    required: 350,
    available,
    ready: available >= 350,
  };
  appState.pairs[pair].lastUpdated = Date.now();
}

export function updateCronRun(): void {
  appState.lastCronRun = Date.now();
}
