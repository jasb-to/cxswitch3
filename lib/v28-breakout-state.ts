import { Redis } from "./supabase-kv";
import type { BreakoutRecord } from "./strategy";

const redis = new Redis();
const KEY = "cxswitch:v28_breakout_state";
export type BreakoutState = Record<string, BreakoutRecord | undefined>;

export async function getLastBreakout(pair:string): Promise<BreakoutRecord|undefined> {
  const state = await redis.get<BreakoutState>(KEY);
  return state?.[pair];
}

export async function setLastBreakout(pair:string, record:BreakoutRecord): Promise<void> {
  const state = (await redis.get<BreakoutState>(KEY)) || {};
  state[pair] = record;
  await redis.set(KEY, state);
}
