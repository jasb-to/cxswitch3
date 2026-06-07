import { Signal } from "./strategy";
import fs from "fs";
import path from "path";

const SIGNALS_CACHE = path.join("/tmp", "cx_signals.json");
const MARKET_CACHE = path.join("/tmp", "cx_market.json");

let signals: Signal[] = [];
let marketData: any[] = [];

// Load signals from file on module init
try {
  if (fs.existsSync(SIGNALS_CACHE)) {
    const raw = fs.readFileSync(SIGNALS_CACHE, "utf-8");
    const parsed = JSON.parse(raw);
    signals = Array.isArray(parsed) ? parsed : [];
    console.log("[STATE] Loaded", signals.length, "signals from /tmp cache");
  }
} catch (err) {
  console.error("[STATE] Signals cache load failed:", err);
  signals = [];
}

// Load market data from file on module init
try {
  if (fs.existsSync(MARKET_CACHE)) {
    const raw = fs.readFileSync(MARKET_CACHE, "utf-8");
    const parsed = JSON.parse(raw);
    marketData = Array.isArray(parsed) ? parsed : [];
    console.log("[STATE] Loaded", marketData.length, "market entries from /tmp cache");
  }
} catch (err) {
  console.error("[STATE] Market cache load failed:", err);
  marketData = [];
}

export function setSignals(data: Signal[]) {
  signals = Array.isArray(data) ? data : [];
  try {
    fs.writeFileSync(SIGNALS_CACHE, JSON.stringify(signals));
  } catch (err) {
    console.error("[STATE] Signals cache write failed:", err);
  }
}

export function getSignals() {
  return signals;
}

export function setMarketData(data: any[]) {
  marketData = Array.isArray(data) ? data : [];
  try {
    fs.writeFileSync(MARKET_CACHE, JSON.stringify(marketData));
  } catch (err) {
    console.error("[STATE] Market cache write failed:", err);
  }
}

export function getMarketData() {
  return marketData;
}
