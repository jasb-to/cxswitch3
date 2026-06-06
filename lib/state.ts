import { Signal } from "./strategy";
import fs from "fs";
import path from "path";

const CACHE_FILE = path.join("/tmp", "cx_signals.json");

let signals: Signal[] = [];

// Load from file on module init
try {
  if (fs.existsSync(CACHE_FILE)) {
    const raw = fs.readFileSync(CACHE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    signals = Array.isArray(parsed) ? parsed : [];
    console.log("[STATE] Loaded", signals.length, "signals from /tmp cache");
  }
} catch (err) {
  console.error("[STATE] Cache load failed:", err);
  signals = [];
}

export function setSignals(data: Signal[]) {
  signals = Array.isArray(data) ? data : [];
  
  // Persist to /tmp
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(signals));
  } catch (err) {
    console.error("[STATE] Cache write failed:", err);
  }
}

export function getSignals() {
  return signals;
}
