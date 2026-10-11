export type StochDirection = "LONG" | "SHORT";
export interface StochSnapshot { k:number; d:number; pk:number; pd:number }
export interface StochEntryTriggers { entry1:boolean; entry2:boolean; fourHCross:boolean; dailyCross:boolean }

export function hasFreshStochCross(stoch:StochSnapshot, direction:StochDirection):boolean {
  return direction==="LONG"
    ? stoch.pk<=stoch.pd && stoch.k>stoch.d
    : stoch.pk>=stoch.pd && stoch.k<stoch.d;
}

/**
 * ENTRY_1 is a fresh 4H crossover aligned with the daily EMA direction.
 * ENTRY_2 requires fresh crossovers on both closed 4H and daily Stoch RSI.
 */
export function evaluateStochEntryTriggers(
  direction:StochDirection|null,
  fourH:StochSnapshot,
  daily:StochSnapshot
):StochEntryTriggers {
  if(!direction)return{entry1:false,entry2:false,fourHCross:false,dailyCross:false};
  const fourHCross=hasFreshStochCross(fourH,direction);
  const dailyCross=hasFreshStochCross(daily,direction);
  return{entry1:fourHCross,entry2:fourHCross&&dailyCross,fourHCross,dailyCross};
}
