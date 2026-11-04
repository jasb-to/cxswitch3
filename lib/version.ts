// CXSwitch system identity.
// V28 = one daily EMA5/13 direction, one shared 4H trendline per pair, and global 4H momentum/exhaustion gates.
export const CXSWITCH_VERSION = 28 as const;
export const ENTRY_ARCHITECTURE = "V28 SINGLE DAILY EMA5/13 + SHARED 4H TRENDLINE" as const;
export const DAILY_BIAS = "1D EMA5/13" as const;
