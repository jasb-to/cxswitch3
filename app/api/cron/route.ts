// ─── STEP 3: Build snapshot ───
// Merge active trade data into the snapshot for the dashboard
const snapshot = await getMarketSnapshot(
  pair,
  candles1h,
  candles4h,
  candles15m,
  price,
  signalResults[pair] // may be undefined for active trades
);

// If we have an active trade, overlay the trade state onto the snapshot
if (results[pair]?.status === "HOLDING") {
  snapshot.activeTrade = {
    signalId: results[pair].signalId,
    state: results[pair].state,
    pnl: results[pair].pnl,
    lockedStop: results[pair].lockedStop,
  };
  // Also ensure regime direction reflects the trade direction
  const activeSignal = activeForPair[0];
  if (activeSignal) {
    snapshot.regime.direction = activeSignal.direction;
    snapshot.regime.strength = "ACTIVE";
    snapshot.regime.confidence = activeSignal.confidence;
    snapshot.recommendedAction = `${activeSignal.direction} HOLDING`;
    snapshot.entryTier = activeSignal.entryTier;
    snapshot.positionSize = activeSignal.positionSizePct ? `${(activeSignal.positionSizePct * 100).toFixed(0)}%` : null;
  }
}

marketSnapshots.push(snapshot);
