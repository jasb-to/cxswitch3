// CXSwitch system identity.
// V30 = daily close/EMA21 regime filter with 4H EMA5/13 timing and Stoch RSI entries.
export const CXSWITCH_VERSION = 30 as const;
export const ENTRY_ARCHITECTURE = "V30 REGIME + 4H STOCH RETEST" as const;
export const DAILY_BIAS = "1D CLOSE/EMA21 + EMA5/13 REGIME" as const;
export const EXECUTION_MODE = "MANUAL" as const;
