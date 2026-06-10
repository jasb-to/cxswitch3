import { Signal } from "./strategy";
import fs from "fs";
import path from "path";

const SIGNALS_CACHE = path.join("/tmp", "cx_signals.json");
const MARKET_CACHE = path.join("/tmp", "cx_market.json");

export function setSignals(data: Signal[]) {
  const signals = Array.isArray(data) ? data : [];
  try {
    fs.writeFileSync(SIGNALS_CACHE, JSON.stringify(signals));
    console.log("[STATE] Saved", signals.length, "signals to /tmp");
  } catch (err) {
    console.error("[STATE] Signals cache write failed:", err);
  }
}

export function getSignals(): Signal[] {
  try {
    if (fs.existsSync(SIGNALS_CACHE)) {
      const raw = fs.readFileSync(SIGNALS_CACHE, "utf-8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch (err) {
    console.error("[STATE] Signals cache read failed:", err);
  }
  return [];
}

export function setMarketData(data: any[]) {
  const marketData = Array.isArray(data) ? data : [];
  try {
    fs.writeFileSync(MARKET_CACHE, JSON.stringify(marketData));
    console.log("[STATE] Saved", marketData.length, "market entries to /tmp");
  } catch (err) {
    console.error("[STATE] Market cache write failed:", err);
  }
}

export function getMarketData(): any[] {
  try {
    if (fs.existsSync(MARKET_CACHE)) {
      const raw = fs.readFileSync(MARKET_CACHE, "utf-8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch (err) {
    console.error("[STATE] Market cache read failed:", err);
  }
  return [];
}
