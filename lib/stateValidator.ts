// State validation - only WATCHING_SHIFT, BUILDING, SNIPER allowed
export type ValidState = "WATCHING_SHIFT" | "BUILDING" | "SNIPER";

const VALID_STATES: Set<ValidState> = new Set([
  "WATCHING_SHIFT",
  "BUILDING",
  "SNIPER",
]);

export function validateState(state: unknown): ValidState {
  if (typeof state === "string" && VALID_STATES.has(state as ValidState)) {
    return state as ValidState;
  }
  
  console.warn(`[STATE] Invalid state "${state}", falling back to WATCHING_SHIFT`);
  return "WATCHING_SHIFT";
}

export function isValidState(state: unknown): state is ValidState {
  return typeof state === "string" && VALID_STATES.has(state as ValidState);
}
