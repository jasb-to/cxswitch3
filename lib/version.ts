// CXSwitch system identity.
// V28 = dual daily direction roles (EMA5/13 ENTRY_1 fast + EMA8/21 macro), one shared 4H trendline and staged signal hysteresis.
export const CXSWITCH_VERSION = 28 as const;
export const ENTRY_ARCHITECTURE = "V28 DUAL DAILY EMA5/13 ENTRY_1 + EMA8/21 MACRO + SHARED 4H TRENDLINE" as const;
export const DAILY_BIAS = "1D EMA8/21 MACRO; 1D EMA5/13 ENTRY_1 FAST" as const;
