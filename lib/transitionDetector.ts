import { ValidState } from "./stateValidator";
import { storeTransition, getPreviousState } from "./persistence";

export interface StateTransition {
  symbol: string;
  fromState: ValidState;
  toState: ValidState;
  hasTransitioned: boolean;
  isSniperEntry: boolean; // true if transitioning TO SNIPER
}

export async function detectTransition(
  symbol: string,
  currentState: ValidState
): Promise<StateTransition> {
  const previousState = await getPreviousState(symbol);
  const hasTransitioned = previousState !== currentState;
  const isSniperEntry = currentState === "SNIPER" && previousState !== "SNIPER";

  if (hasTransitioned) {
    const now = new Date().toISOString();
    await storeTransition({
      symbol,
      fromState: previousState,
      toState: currentState,
      timestamp: now,
    });

    console.log(
      `[TRANSITION] ${symbol}: ${previousState} → ${currentState}`
    );
  }

  return {
    symbol,
    fromState: previousState,
    toState: currentState,
    hasTransitioned,
    isSniperEntry,
  };
}
