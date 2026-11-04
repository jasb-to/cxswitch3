// lib/strategy.ts — v28 "Trendline Break: StochRSI Timing + Position Build"
// ============================================================
// Architecture: stateful trendline, hysteresis bands, TV-exact StochRSI
// EXIT: Stoch extreme opposite (matches chart)
// ALERTS: ENTRY_1 and ADD only (ENTRY_2 is internal, no alert)

import { getHysteresisState, setHysteresisState, getTrendlineState, setTrendlineState } from "./state";

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Signal {
 id:string; pair:string; direction:"LONG"|"SHORT";
 type:"ENTRY_1"|"ENTRY_2"|"ADD"|"REVERSAL_SHORT"|"REVERSAL_LONG";
 signalClass:"TREND"|"REVERSAL"; sizeMultiplier:0.5|1;
 entry:number; stop:number; tp1:number; tp2:number; rr:number;
 adx:number; rsi:number; stochK:number; stochD:number; expectedMove:number;
 reason:string; timestamp:number; version:number; context?:any;
}

export interface Entry1State { pair:string; direction:"LONG"|"SHORT"; entry:number; timestamp:number; context?:any; }
export interface BreakoutRecord { direction:"LONG"|"SHORT"; price:number; timestamp:number; candleIndex:number; }
export interface SignalResult {
  signal?: Signal;
  market?: any;
  debug: string[];
  breakoutRecord?: BreakoutRecord;
}

export const CURRENT_SIGNAL_VERSION = 28;
const MIN_RR = 1.5;
type Direction="LONG"|"SHORT";
function daily(c:Candle[]):Candle[]{return aggregateTo1D(c);}
export type RegimeStrength="HIGH"|"MED"|"LOW";
export type RegimeState="BULL_HIGH"|"BULL_MED"|"BULL_LOW"|"CHOP"|"BEAR_LOW"|"BEAR_MED"|"BEAR_HIGH";
export interface ComputedRegime {
  state:RegimeState; direction:Direction|null; sizeMultiplier:0|0.5|1;
  price:number; e21:number; e5:number; e13:number; spread:number; spread3:number; spreadDelta:number;
  strength:RegimeStrength|"NEUTRAL";
}
export function computeRegime(c:Candle[]):ComputedRegime {
  const d=daily(c).slice(0,-1),closes=d.map(x=>x.close);
  const neutral:ComputedRegime={state:"CHOP",direction:null,sizeMultiplier:0,price:closes.at(-1)??0,e21:0,e5:0,e13:0,spread:0,spread3:0,spreadDelta:0,strength:"NEUTRAL"};
  if(closes.length<22)return neutral;
  const e5s=ema(closes,5),e13s=ema(closes,13),e21s=ema(closes,21);
  const price=closes.at(-1)!,e5=e5s.at(-1)!,e13=e13s.at(-1)!,e21=e21s.at(-1)!;
  const aboveE21=price>e21,emaStack=e5>e13?"BULL":"BEAR";
  const spread=(e5-e13)/price*100;
  const spread3=closes.length>=25?(e5s.at(-4)!-e13s.at(-4)!)/closes.at(-4)!*100:spread;
  const spreadDelta=spread-spread3;
  let strength:RegimeStrength;
  if(Math.abs(spreadDelta)<0.05)strength="MED";
  else if((emaStack==="BULL"&&spreadDelta>0)||(emaStack==="BEAR"&&spreadDelta<0))strength="HIGH";
  else strength="LOW";
  let state:RegimeState;
  if(emaStack==="BULL"&&aboveE21)state=("BULL_"+strength) as RegimeState;
  else if(emaStack==="BEAR"&&!aboveE21)state=("BEAR_"+strength) as RegimeState;
  else state="CHOP";
  const direction:Direction|null=state.startsWith("BULL")?"LONG":state.startsWith("BEAR")?"SHORT":null;
  const sizeMultiplier:0|0.5|1=strength==="LOW"||state==="CHOP"?0.5:1;
  return{state,direction,sizeMultiplier,price,e21,e5,e13,spread,spread3,spreadDelta,strength:direction?strength:"NEUTRAL"};
}

export function getStochHistoryPointCount(closes:number[]):number{return Math.max(0,rsiSeries(closes).length-17);}

// --- STATEFUL TRENDLINE STORE ---
interface TrendlineState {
  slope: number;
  intercept: number;
  pivots: { index: number; price: number; timestamp: number }[];
  lastUpdated: number;
  direction: "LONG" | "SHORT";
}

const trendlineStore: Map<string, TrendlineState> = new Map();

// --- KV PERSISTENCE (serverless-safe) ---

export async function loadTrendlinesFromKV(): Promise<void> {
  const state = await getTrendlineState();
  trendlineStore.clear();
  for (const [pair, data] of Object.entries(state)) {
    trendlineStore.set(pair, data as TrendlineState);
  }
}

export async function saveTrendlinesToKV(): Promise<void> {
  const state: Record<string, any> = {};
  for (const [pair, data] of trendlineStore.entries()) {
    state[pair] = data;
  }
  await setTrendlineState(state);
}

function avg(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// --- RSI (TradingView exact — Wilder smoothed) ---
function rsi(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50;
  
  let avgGain = 0;
  let avgLoss = 0;
  
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;
  
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// --- RSI SERIES (precomputed with Wilder smoothing) ---
function rsiSeries(closes: number[], period: number = 14): number[] {
  if (closes.length < period + 1) return [];
  
  const series: number[] = [];
  let avgGain = 0;
  let avgLoss = 0;
  
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;
  
  const firstRs = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  series.push(Math.round(firstRs * 10) / 10);
  
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    
    if (avgLoss === 0) {
      series.push(100);
    } else {
      const rs = avgGain / avgLoss;
      series.push(Math.round((100 - (100 / (1 + rs))) * 10) / 10);
    }
  }
  
  return series;
}

// --- STOCHRSI (TradingView exact) ---
function stochRsi(closes: number[], rsiPeriod: number = 14, stochPeriod: number = 14, kSmooth: number = 3, dSmooth: number = 3): { k: number; d: number } {
  const rsiValues = rsiSeries(closes, rsiPeriod);
  
  if (rsiValues.length < stochPeriod + kSmooth - 1) return { k: 50, d: 50 };
  
  const rawK: number[] = [];
  for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
    const window = rsiValues.slice(i - stochPeriod + 1, i + 1);
    const lowest = Math.min(...window);
    const highest = Math.max(...window);
    if (highest === lowest) {
      rawK.push(50);
    } else {
      rawK.push(((rsiValues[i] - lowest) / (highest - lowest)) * 100);
    }
  }
  
  const kValues: number[] = [];
  for (let i = kSmooth - 1; i < rawK.length; i++) {
    kValues.push(avg(rawK.slice(i - kSmooth + 1, i + 1)));
  }
  
  if (kValues.length < dSmooth) return { k: 50, d: 50 };
  
  const currentK = kValues[kValues.length - 1];
  const currentD = avg(kValues.slice(-dSmooth));
  
  return { k: Math.round(currentK * 10) / 10, d: Math.round(currentD * 10) / 10 };
}

// --- WILDER SMOOTHING ---
function wilderSmooth(values: number[], period: number): number[] {
  const result: number[] = [avg(values.slice(0, period))];
  for (let i = period; i < values.length; i++) {
    result.push((result[result.length - 1] * (period - 1) + values[i]) / period);
  }
  return result;
}

// --- ADX (Wilder-smoothed, proper) ---
function adx(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return 0;
  
  const trs: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];
  
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    plusDMs.push(c.high - p.high > p.low - c.low ? Math.max(c.high - p.high, 0) : 0);
    minusDMs.push(p.low - c.low > c.high - p.high ? Math.max(p.low - c.low, 0) : 0);
  }
  
  const atrSmooth = wilderSmooth(trs, period);
  const plusDISmooth = wilderSmooth(plusDMs, period);
  const minusDISmooth = wilderSmooth(minusDMs, period);
  
  const dxValues: number[] = [];
  for (let i = 0; i < atrSmooth.length; i++) {
    const pDI = (plusDISmooth[i] / atrSmooth[i]) * 100;
    const mDI = (minusDISmooth[i] / atrSmooth[i]) * 100;
    const dx = (pDI + mDI === 0) ? 0 : (Math.abs(pDI - mDI) / (pDI + mDI)) * 100;
    dxValues.push(dx);
  }
  
  const adxSmooth = wilderSmooth(dxValues, period);
  return Math.round(adxSmooth[adxSmooth.length - 1] * 10) / 10;
}

// --- AGGREGATE 4H TO 1D ---
function aggregateTo1D(candles4h: Candle[]): Candle[] {
  const sorted = [...candles4h].sort((a, b) => a.timestamp - b.timestamp);
  const groups: Map<string, Candle[]> = new Map();
  
  for (const c of sorted) {
    const date = new Date(c.timestamp);
    const key = `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  
  const daily: Candle[] = [];
  for (const [, bars] of groups) {
    if (bars.length === 0) continue;
    daily.push({
      timestamp: bars[0].timestamp,
      open: bars[0].open,
      high: Math.max(...bars.map(b => b.high)),
      low: Math.min(...bars.map(b => b.low)),
      close: bars[bars.length - 1].close,
      volume: bars.reduce((sum, b) => sum + b.volume, 0),
    });
  }
  
  return daily.sort((a, b) => a.timestamp - b.timestamp);
}

// --- FIND PIVOTS ---
function findPivots(candles: Candle[], direction: "LONG" | "SHORT"): { index: number; price: number; timestamp: number }[] {
  const pivots: { index: number; price: number; timestamp: number }[] = [];
  
  for (let i = 3; i < candles.length - 3; i++) {
    const c = candles[i];
    const isSwingLow = c.low < candles[i-1].low && c.low < candles[i-2].low && c.low < candles[i+1].low && c.low < candles[i+2].low;
    const isSwingHigh = c.high > candles[i-1].high && c.high > candles[i-2].high && c.high > candles[i+1].high && c.high > candles[i+2].high;
    
    if (direction === "LONG" && isSwingLow) {
      pivots.push({ index: i, price: c.low, timestamp: c.timestamp });
    }
    if (direction === "SHORT" && isSwingHigh) {
      pivots.push({ index: i, price: c.high, timestamp: c.timestamp });
    }
  }
  
  return pivots;
}

// --- STATEFUL TRENDLINE ---
function getTrendline(pair: string, candles: Candle[], direction: "LONG" | "SHORT"): { price: number; r2: number; age: number } | null {
  const len = candles.length;
  if (len < 20) return null;
  
  const pivots = findPivots(candles, direction);
  if (pivots.length < 3) return null;
  
  const recentPivots = pivots.slice(-5);
  const now = candles[candles.length - 1].timestamp;
  
  const existing = trendlineStore.get(pair);
  const maxAge = 7 * 24 * 60 * 60 * 1000;
  
  if (existing && existing.direction === direction && (now - existing.lastUpdated) < maxAge) {
    const lastPivot = recentPivots[recentPivots.length - 1];
    const projectedPrice = existing.slope * lastPivot.index + existing.intercept;
    const deviation = Math.abs(lastPivot.price - projectedPrice) / projectedPrice;
    
    if (deviation < 0.02) {
      const currentIndex = len - 1;
      const price = existing.slope * currentIndex + existing.intercept;
      return { price, r2: 0.85, age: now - existing.lastUpdated };
    }
  }
  
  const n = recentPivots.length;
  const sumX = recentPivots.reduce((s, p) => s + p.index, 0);
  const sumY = recentPivots.reduce((s, p) => s + p.price, 0);
  const sumXY = recentPivots.reduce((s, p) => s + p.index * p.price, 0);
  const sumX2 = recentPivots.reduce((s, p) => s + p.index * p.index, 0);
  
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  
  const yMean = sumY / n;
  const ssTotal = recentPivots.reduce((s, p) => s + Math.pow(p.price - yMean, 2), 0);
  const ssResidual = recentPivots.reduce((s, p) => s + Math.pow(p.price - (slope * p.index + intercept), 2), 0);
  const r2 = ssTotal === 0 ? 0 : 1 - (ssResidual / ssTotal);
  
  trendlineStore.set(pair, {
    slope,
    intercept,
    pivots: recentPivots,
    lastUpdated: now,
    direction,
  });
  
  const currentIndex = len - 1;
  const price = slope * currentIndex + intercept;
  
  return { price, r2: Math.round(r2 * 100) / 100, age: 0 };
}

// --- 1D TREND ---
function trend1D(candles1d: Candle[]): { direction: "LONG" | "SHORT" | null; strength: string } {
  const len = candles1d.length;
  if (len < 25) return { direction: null, strength: "WEAK" };
  
  const closes = candles1d.map(c => c.close);
  const ema8 = ema(closes, 8);
  const ema21 = ema(closes, 21);
  
  const direction = ema8[ema8.length - 1] > ema21[ema21.length - 1] ? "LONG" : "SHORT";
  
  const highs = candles1d.slice(-20).map(c => c.high);
  const lows = candles1d.slice(-20).map(c => c.low);
  const hh = highs[highs.length - 1] > Math.max(...highs.slice(0, -1));
  const ll = lows[lows.length - 1] < Math.min(...lows.slice(0, -1));
  
  const strength = (direction === "LONG" && hh) || (direction === "SHORT" && ll) ? "STRONG" : "MEDIUM";
  
  return { direction, strength };
}


function trend1DEntry1(candles1d:Candle[]): { direction: Direction|null; ema5:number; ema13:number } {
  const closes=candles1d.map(c=>c.close);
  if(closes.length<13)return{direction:null,ema5:0,ema13:0};
  const e5=ema(closes,5).at(-1)??0,e13=ema(closes,13).at(-1)??0;
  return{direction:e5>e13?"LONG":e5<e13?"SHORT":null,ema5:e5,ema13:e13};
}

function ema(closes: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    ema.push(closes[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

// --- ATR ---
function atr(candles: Candle[], period: number = 14): number {
  const start = Math.max(1, candles.length - period);
  const trs: number[] = [];
  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return avg(trs);
}

// --- HYSTERESIS STATE ---
interface HysteresisState {
  lastSignalType: "ENTRY_1" | "ENTRY_2" | "ADD" | null;
  lastSignalPrice: number;
  lockUntil: number;
}

const hysteresisStore: Map<string, HysteresisState> = new Map();

// --- KV PERSISTENCE (serverless-safe) ---

export async function loadHysteresisFromKV(): Promise<void> {
  const state = await getHysteresisState();
  hysteresisStore.clear();
  for (const [pair, data] of Object.entries(state)) {
    hysteresisStore.set(pair, data as HysteresisState);
  }
}

export async function saveHysteresisToKV(): Promise<void> {
  const state: Record<string, any> = {};
  for (const [pair, data] of hysteresisStore.entries()) {
    state[pair] = data;
  }
  await setHysteresisState(state);
}

const HYSTERESIS_BAND = 0.005; // 0.5%

function getHysteresis(pair: string, now: number): HysteresisState {
  const state = hysteresisStore.get(pair);
  if (!state) return { lastSignalType: null, lastSignalPrice: 0, lockUntil: 0 };
  if (now > state.lockUntil) return { lastSignalType: null, lastSignalPrice: 0, lockUntil: 0 };
  return state;
}

function setHysteresis(pair: string, type: "ENTRY_1" | "ENTRY_2" | "ADD", price: number, now: number): void {
  const lockDuration = type === "ADD" ? 4 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  hysteresisStore.set(pair, {
    lastSignalType: type,
    lastSignalPrice: price,
    lockUntil: now + lockDuration,
  });
}

export interface DirectionalFilterResult { momentum:boolean; exhaustion:string|null; pass:boolean; }
export function evaluateDirectionalFilters(direction:Direction|null,e5:number,e13:number,rv:number,stochK:number,stochD:number,adxValue:number):DirectionalFilterResult {
 if(!direction)return{momentum:false,exhaustion:"daily_direction_unavailable",pass:false};
 const momentum=direction==="LONG"?e5>e13:e5<e13;
 const rsiVeto=direction==="LONG"?rv>78:rv<22;
 const stochVeto=direction==="LONG"?stochK>95:stochK<5;
 const turningAgainst=direction==="LONG"?stochK<stochD:stochK>stochD;
 const exhaustion=rsiVeto?"4H RSI exhaustion":stochVeto?"4H Stoch extreme veto":adxValue>50&&turningAgainst?"ADX >50 with Stoch turning against":null;
 return{momentum,exhaustion,pass:momentum&&!exhaustion};
}
export function entry1TriggerPass(direction:Direction|null,nearTrendline:boolean,stochK:number,filtersPass:boolean,activeMatch:boolean):boolean {
 const extreme=direction==="LONG"?stochK<20:direction==="SHORT"?stochK>80:false;
 return !!direction&&nearTrendline&&extreme&&filtersPass&&!activeMatch;
}
export function entry2TriggerPass(direction:Direction|null,nearTrendline:boolean,stochK:number,stochD:number,filtersPass:boolean,activeMatch:boolean):boolean {
 if(!direction)return false;
 const extreme=direction==="LONG"?stochK<20:stochK>80;
 const turning=direction==="LONG"?stochK>stochD:stochK<stochD;
 return nearTrendline&&turning&&!extreme&&filtersPass&&activeMatch;
}

// --- MAIN SIGNAL ---
export function evaluateGates(
 pair:string,candles4h:Candle[],currentPrice:number,entry1State?:any,entry2AlreadyFired=false,
 activeSignals:Array<{pair:string;direction:"LONG"|"SHORT"}>=[]
):any{
 void entry1State;void entry2AlreadyFired;
 const c=[...candles4h].sort((a,b)=>a.timestamp-b.timestamp),price=currentPrice??c.at(-1)?.close??0;
 const daily=aggregateTo1D(c),fast=trend1DEntry1(daily),macro=trend1D(daily),dailyCloses=daily.map(x=>x.close);
 const dailyE8=ema(dailyCloses,8).at(-1)??0,dailyE21=ema(dailyCloses,21).at(-1)??0;
 const closed=c.slice(0,-1),closes=closed.map(x=>x.close),st=stochRsi(closes),rv=rsi(closes),av=adx(closed);
 const e5=ema(closes,5).at(-1)??0,e13=ema(closes,13).at(-1)??0;
 const filters=(dir:Direction|null)=>evaluateDirectionalFilters(dir,e5,e13,rv,st.k,st.d,av);
 const fastFilters=filters(fast.direction),fastTl=fast.direction?getTrendline(pair,c,fast.direction):null;
 const fastDist=fastTl&&fastTl.price>0?Math.abs(price-fastTl.price)/fastTl.price*100:Infinity;
 const fastNear=!!fastTl&&fastDist<1.2,fastExtreme=fast.direction==="LONG"?st.k<20:fast.direction==="SHORT"?st.k>80:false;
 const fastActive=!!fast.direction&&activeSignals.some(x=>x.pair===pair&&x.direction===fast.direction);
 const entry1=entry1TriggerPass(fast.direction,fastNear,st.k,fastFilters.pass,fastActive);
 // ENTRY_1 gets first evaluation. If it does not fire, the single pair trendline state
 // is recalculated/overwritten for the MACRO direction before ENTRY_2 / ADD checks.
 let macroTl:ReturnType<typeof getTrendline>=null,macroDist=Infinity,macroNear=false,entry2=false,addReady=false;
 let macroFilters=filters(macro.direction),macroActive=false,beyond=false,confirming=false,volUp=false,stochMomentum=false;
 const last=closed.at(-1),prev=closed.at(-2);
 if(!entry1&&macro.direction){
   macroTl=getTrendline(pair,c,macro.direction);
   macroDist=macroTl&&macroTl.price>0?Math.abs(price-macroTl.price)/macroTl.price*100:Infinity;
   macroNear=!!macroTl&&macroDist<1.2;
   macroActive=activeSignals.some(x=>x.pair===pair&&x.direction===macro.direction);
   entry2=entry2TriggerPass(macro.direction,macroNear,st.k,st.d,macroFilters.pass,macroActive);
   beyond=!!macroTl&&(macro.direction==="LONG"?price>macroTl.price*1.008:price<macroTl.price*0.992);
   confirming=!!last&&!!prev&&(macro.direction==="LONG"?last.close>last.open&&last.close>prev.close:last.close<last.open&&last.close<prev.close);
   volUp=!!last&&last.volume>avg(closed.slice(-10).map(x=>x.volume))*1.3;
   stochMomentum=macro.direction==="LONG"?st.k>st.d:st.k<st.d;
   addReady=macroActive&&beyond&&confirming&&macroFilters.pass&&(volUp||stochMomentum||av>20);
 }
 const signalType:"ENTRY_1"|"ENTRY_2"|"ADD"|null=entry1?"ENTRY_1":entry2?"ENTRY_2":addReady?"ADD":null;
 const selectedDir=signalType==="ENTRY_1"?fast.direction:macro.direction;
 const selectedTl=signalType==="ENTRY_1"?fastTl:macroTl;
 const selectedDist=signalType==="ENTRY_1"?fastDist:macroDist;
 const selectedFilters=signalType==="ENTRY_1"?fastFilters:macroFilters;
 const missing:string[]=[];
 if(!fast.direction&&!macro.direction)missing.push("daily_ema_direction_unavailable");
 if(!entry1&&!macro.direction)missing.push("macro_daily_ema8_21_unavailable");
 if(!entry1&&!macroTl)missing.push("trendline_unavailable_for_macro_direction");
 if(fast.direction&&!fastTl)missing.push("trendline_unavailable_for_fast_direction");
 if(fast.direction&&!fastNear)missing.push("ENTRY_1 outside 1.2% trendline proximity");
 if(fast.direction&&fastNear&&!fastExtreme)missing.push("ENTRY_1 waiting for Stoch RSI extreme");
 if(fast.direction&&!fastFilters.momentum)missing.push("ENTRY_1 4H EMA5/13 momentum misaligned");
 if(fastFilters.exhaustion)missing.push("ENTRY_1 exhaustion veto: "+fastFilters.exhaustion);
 if(macro.direction&&!macroFilters.momentum)missing.push("ENTRY_2/ADD 4H EMA5/13 momentum misaligned");
 if(macroFilters.exhaustion)missing.push("ENTRY_2/ADD exhaustion veto: "+macroFilters.exhaustion);
 if(!signalType)missing.push("V28 trendline / Stoch trigger not met");
 const regime=computeRegime(c),macroDirection=macro.direction??null;
 const alignment={daily:macroDirection,dailyE8,dailyE21,dailyE5:fast.ema5,dailyE13:fast.ema13,fastDailyDirection:fast.direction,macroDailyDirection:macroDirection,fourHE5:e5,fourHE13:e13,fourH:e5>e13?"LONG":e5<e13?"SHORT":null,regime:regime.state,sizeMultiplier:regime.sizeMultiplier};
 return{direction:selectedDir??null,zone:null,trendlineSlope:0,trendline:selectedTl?{price:selectedTl.price,distancePct:selectedDist,r2:selectedTl.r2,reason:"V28 shared pair trendline"}:null,alignment,trigger:{entry1,entry2,add:addReady,signalType,entry1Reason:entry1?"FAST EMA5/13 + trendline proximity + Stoch extreme + global filters":missing.join("; "),entry1Direction:fast.direction,entry1Trendline:fastTl?{price:fastTl.price,distancePct:fastDist}:null,entry2Reason:entry2?"MACRO EMA8/21 + trendline proximity + Stoch turn + global filters":"not_ready",entry1SizeMultiplier:1,entry1CrossAgeInCandles:null,entry1Case:entry1?"fresh":null},exhaustion:selectedFilters.exhaustion,stopCalc:null,missing:[...new Set(missing)],allPassed:!!signalType&&selectedFilters.pass&&!!selectedTl&&(signalType==="ENTRY_1"||macroNear||signalType==="ADD"),dailyTransition:false,breakoutRecord:undefined};
}

export function generateSignal(pair:string,candles1h:Candle[],candles4h:Candle[],candles15m:Candle[],currentPrice?:number,nowOverride?:number,lastBreakout?:any,entry1State?:any,entry2AlreadyFired=false,activeSignals:Array<{pair:string;direction:"LONG"|"SHORT"}>=[]):SignalResult{
 void candles1h;void candles15m;void lastBreakout;void entry1State;void entry2AlreadyFired;
 const debug:string[]=[],c=[...candles4h].sort((a,b)=>a.timestamp-b.timestamp),now=nowOverride??Date.now();
 if(c.length<30){debug.push("[WAIT] Insufficient 4H candle data");return{market:getMarketSnapshot(pair,candles1h,candles4h,candles15m),debug};}
 const dailyCandles=aggregateTo1D(c);if(dailyCandles.length<25){debug.push("[WAIT] Insufficient daily history");return{market:getMarketSnapshot(pair,candles1h,candles4h,candles15m),debug};}
 const fast=trend1DEntry1(dailyCandles),macro=trend1D(dailyCandles),regime=computeRegime(c);
 debug.push("[DAILY] FAST EMA5/13="+(fast.direction??"NONE")+" | MACRO EMA8/21="+(macro.direction??"NONE")+" | size="+Math.round(regime.sizeMultiplier*100)+"%");
 if(!fast.direction&&!macro.direction){debug.push("[WAIT] Daily direction unavailable");return{market:getMarketSnapshot(pair,candles1h,candles4h,candles15m),debug};}
 const price=currentPrice??c.at(-1)!.close,closes=c.map(x=>x.close),st=stochRsi(closes),rv=rsi(closes),av=adx(c);
 const e5=ema(closes,5).at(-1)??0,e13=ema(closes,13).at(-1)??0;
 const filters=(dir:Direction|null)=>evaluateDirectionalFilters(dir,e5,e13,rv,st.k,st.d,av);
 const fastFilters=filters(fast.direction),fastTl=fast.direction?getTrendline(pair,c,fast.direction):null;
 const fastDistance=fastTl?Math.abs(price-fastTl.price)/fastTl.price*100:Infinity,fastNear=!!fastTl&&fastDistance<1.2;
 const fastExtreme=fast.direction==="LONG"?st.k<20:fast.direction==="SHORT"?st.k>80:false;
 const fastActive=!!fast.direction&&activeSignals.some(x=>x.pair===pair&&x.direction===fast.direction);
 debug.push("[ENTRY_1] FAST "+(fast.direction??"NONE")+" | TL="+(fastTl?.price.toFixed(2)??"unavailable")+" | distance="+(Number.isFinite(fastDistance)?fastDistance.toFixed(2):"n/a")+"% | near="+fastNear+" | Stoch extreme="+fastExtreme+" | momentum="+fastFilters.momentum+" | exhaustion="+(fastFilters.exhaustion??"clear"));
 let finalType:"ENTRY_1"|"ENTRY_2"|"ADD"|null=null,signalDirection:Direction|null=null,signalTl:ReturnType<typeof getTrendline>=null;
 if(entry1TriggerPass(fast.direction,fastNear,st.k,fastFilters.pass,fastActive)){finalType="ENTRY_1";signalDirection=fast.direction;signalTl=fastTl;}
 else {
   // One shared KV key per pair: macro evaluation intentionally overwrites FAST trendline state.
   const macroTl=macro.direction?getTrendline(pair,c,macro.direction):null;
   const macroDistance=macroTl?Math.abs(price-macroTl.price)/macroTl.price*100:Infinity,macroNear=!!macroTl&&macroDistance<1.2;
   const macroFilters=filters(macro.direction),macroActive=!!macro.direction&&activeSignals.some(x=>x.pair===pair&&x.direction===macro.direction);
   const last=c.at(-1)!,prev=c.at(-2)!,beyond=!!macroTl&&(macro.direction==="LONG"?price>macroTl.price*1.008:price<macroTl.price*0.992);
   const confirming=!!macro.direction&&(macro.direction==="LONG"?last.close>last.open&&last.close>prev.close:last.close<last.open&&last.close<prev.close);
   const volUp=last.volume>avg(c.slice(-10).map(x=>x.volume))*1.3,stochMomentum=macro.direction==="LONG"?st.k>st.d:st.k<st.d;
   const entry2=entry2TriggerPass(macro.direction,macroNear,st.k,st.d,macroFilters.pass,macroActive);
   const add=!!macro.direction&&macroActive&&beyond&&confirming&&macroFilters.pass&&(volUp||stochMomentum||av>20);
   debug.push("[MACRO] "+(macro.direction??"NONE")+" | TL="+(macroTl?.price.toFixed(2)??"unavailable")+" | distance="+(Number.isFinite(macroDistance)?macroDistance.toFixed(2):"n/a")+"% | near="+macroNear+" | momentum="+macroFilters.momentum+" | exhaustion="+(macroFilters.exhaustion??"clear")+" | ENTRY_2="+entry2+" | ADD="+add);
   if(entry2){finalType="ENTRY_2";signalDirection=macro.direction;signalTl=macroTl;}
   else if(add){finalType="ADD";signalDirection=macro.direction;signalTl=macroTl;}
   if(!finalType&&fast.direction&&fastNear&&fastExtreme&&(!fastFilters.pass||fastActive))debug.push("[VETO] ENTRY_1 "+(!fastFilters.momentum?"4H EMA5/13 momentum misaligned":fastFilters.exhaustion??"active position already exists"));
   if(!finalType&&macro.direction&&(!macroFilters.pass||!macroNear))debug.push("[VETO] MACRO "+(!macroFilters.momentum?"4H EMA5/13 momentum misaligned":macroFilters.exhaustion??"trendline proximity/trigger not met"));
 }
 if(!finalType||!signalDirection||!signalTl){debug.push("[WAIT] No valid FAST ENTRY_1 or MACRO ENTRY_2/ADD trigger");return{market:getMarketSnapshot(pair,candles1h,candles4h,candles15m),debug};}
 debug.push("[TRIGGER] "+finalType+" "+signalDirection);
 const hyst=getHysteresis(pair,now);if(hyst.lastSignalType===finalType&&hyst.lastSignalPrice>0){const move=Math.abs(price-hyst.lastSignalPrice)/hyst.lastSignalPrice;if(move<HYSTERESIS_BAND){debug.push("[WAIT] Hysteresis lock "+finalType);return{market:getMarketSnapshot(pair,candles1h,candles4h,candles15m),debug};}}
 if(finalType!==hyst.lastSignalType)setHysteresis(pair,finalType,price,now);
 const avalue=atr(c,14),recent=c.slice(-20);if(!Number.isFinite(avalue)||avalue<=0)return{debug:["[SIGNAL BLOCKED] invalid ATR"]};
 const low=Math.min(...recent.map(x=>x.low)),high=Math.max(...recent.map(x=>x.high));let stop:number,target:number;
 if(finalType==="ENTRY_1"||finalType==="ENTRY_2"){stop=signalDirection==="LONG"?Math.min(low,price-2*avalue):Math.max(high,price+2*avalue);target=signalDirection==="LONG"?price+5*avalue:price-5*avalue;}
 else{stop=signalDirection==="LONG"?Math.min(signalTl.price*0.995,price-1.5*avalue):Math.max(signalTl.price*1.005,price+1.5*avalue);const floor=signalDirection==="LONG"?price+(price-stop)*MIN_RR:price-(stop-price)*MIN_RR;target=signalDirection==="LONG"?Math.max(high,floor):Math.min(low,floor);}
 const rr=signalDirection==="LONG"?(target-price)/(price-stop):(price-target)/(stop-price);if(!Number.isFinite(rr)||rr<MIN_RR)return{debug:["[SIGNAL BLOCKED] R:R "+rr.toFixed(2)+" < "+MIN_RR]};
 const size=regime.sizeMultiplier===0.5?0.5:1;
 const signal:Signal={id:pair+"_"+finalType+"_"+now,pair,direction:signalDirection,type:finalType,signalClass:"TREND",sizeMultiplier:size,entry:Math.round(price*100)/100,stop:Math.round(stop*100)/100,tp1:Math.round(target*100)/100,tp2:Math.round(target*100)/100,rr:Math.round(rr*100)/100,adx:Math.round(av*10)/10,rsi:Math.round(rv*10)/10,stochK:st.k,stochD:st.d,expectedMove:Math.round(Math.abs(target-price)/price*1000)/10,reason:signalDirection+" "+finalType+" | "+(finalType==="ENTRY_1"?"FAST daily EMA5/13 + trendline proximity + Stoch extreme + 4H momentum/exhaustion filters":"MACRO daily EMA8/21 + trendline trigger + 4H momentum/exhaustion filters")+" | "+regime.state,timestamp:now,version:CURRENT_SIGNAL_VERSION,context:{targetCount:1,targetAtrMultiple:5,regime:regime.state,regimeSizeMultiplier:size,trendlinePrice:signalTl.price,trendlineR2:signalTl.r2,fastDailyDirection:fast.direction,macroDailyDirection:macro.direction,ema5_1d:fast.ema5,ema13_1d:fast.ema13,ema5_4h:e5,ema13_4h:e13}};
 debug.push("[STOP] "+signal.stop+" | V28 swing/ATR stop");debug.push("[TARGET] "+signal.tp1+" | V28 ATR/swing target; TP2 mirrors TP1");debug.push("[SIGNAL] "+signal.direction+" "+signal.type+" entry="+signal.entry+" SL="+signal.stop+" TP="+signal.tp1+" RR="+signal.rr);
 return{signal,market:getMarketSnapshot(pair,candles1h,candles4h,candles15m),debug};
}

// --- MARKET SNAPSHOT ---
export function getMarketSnapshot(pair:string,candles1h:Candle[],candles4h:Candle[],candles15m:Candle[]):any{
 void candles1h;void candles15m;
 const c=[...candles4h].sort((a,b)=>a.timestamp-b.timestamp),d=aggregateTo1D(c),t=trend1D(d),reg=computeRegime(c),closed=c.slice(0,-1),q=closed.map(x=>x.close),dq=d.slice(0,-1).map(x=>x.close);
 const st=stochRsi(q),st1=stochRsi(dq),dailyCloses=d.map(x=>x.close),e5=ema(q,5).at(-1)??0,e13=ema(q,13).at(-1)??0,e8=ema(q,8).at(-1)??0,e21=ema(q,21).at(-1)??0,d8=ema(dailyCloses,8).at(-1)??0,d21=ema(dailyCloses,21).at(-1)??0,d5=ema(dailyCloses,5).at(-1)??0,d13=ema(dailyCloses,13).at(-1)??0;
 const storedTrendline=trendlineStore.get(pair),tl=storedTrendline?{price:storedTrendline.slope*(c.length-1)+storedTrendline.intercept,r2:0.85,age:Date.now()-storedTrendline.lastUpdated}:null,price=c.at(-1)?.close??0;
 const entry1Direction=d5>d13?"LONG":d5<d13?"SHORT":"NEUTRAL";
  const fastDailyDirection=entry1Direction,macroDailyDirection=t.direction??"NEUTRAL";
 return{pair,price,timestamp:Date.now(),trend:reg.state,regime:reg.state,dailyDirection:t.direction==="LONG"?"BULL":t.direction==="SHORT"?"BEAR":"NEUTRAL",fastDailyDirection,macroDailyDirection,entry1DailyDirection:entry1Direction,dailyStrength:t.strength,dailyClose:dq.at(-1)??0,dailyE21:d21,dailyE8:d8,ema8_1d:d8,ema21_1d:d21,ema5_1d:d5,ema13_1d:d13,ema5_4h:e5,ema13_4h:e13,ema8_4h:e8,ema21_4h:e21,fourHTacticalDirection:e5>e13?"BULL":e5<e13?"BEAR":"NEUTRAL",fourHDirection:e8>e21?"BULL":e8<e21?"BEAR":"NEUTRAL",alignedDirection:t.direction,trendlineDistancePct:tl?Math.abs(price-tl.price)/tl.price*100:null,stochK:st.k,stochD:st.d,stochK4h:st.k,stochD4h:st.d,stochK1d:st1.k,stochD1d:st1.d,adx:adx(closed),rsi:rsi(q),trendlinePrice:tl?.price??0,distToTrendline:tl?Math.abs(price-tl.price)/tl.price*100:null,sizeMultiplier:reg.sizeMultiplier,strategyStatus:"V28 — "+(t.direction??"NO DAILY TREND")};
}

// --- VALIDITY ---
export interface ValidityCheck{valid:boolean;reason:string;exited:boolean}
export function isSignalStillValid(signal:Signal,p:number,now:number=Date.now()):ValidityCheck{
 const ttl=signal.type==="ADD"?4*60*60*1000:24*60*60*1000;
 if(now-signal.timestamp>ttl)return{valid:false,reason:"expired_ttl",exited:true};
 const entryBuffer=signal.type==="ADD"?1.005:1.02;
 if((signal.direction==="LONG"&&p>signal.entry*entryBuffer)||(signal.direction==="SHORT"&&p<signal.entry*(2-entryBuffer)))return{valid:false,reason:"missed_entry",exited:true};
 if((signal.direction==="LONG"&&p<=signal.stop)||(signal.direction==="SHORT"&&p>=signal.stop))return{valid:false,reason:"sl_hit",exited:true};
 const tp=signal.tp1??signal.tp2;if((signal.direction==="LONG"&&p>=tp)||(signal.direction==="SHORT"&&p<=tp))return{valid:false,reason:"tp_hit",exited:true};
 return{valid:true,reason:"active",exited:false};
}
export function filterExpiredSignals(signals:Signal[],prices:Record<string,number>,now?:number){const active:Signal[]=[],exited:{signal:Signal;reason:string}[]=[];for(const s of signals){const p=prices[s.pair];if(p===undefined){active.push(s);continue}const v=isSignalStillValid(s,p,now);if(v.valid)active.push(s);else exited.push({signal:s,reason:v.reason});}return{active,exited};}
export type TradeStatus="ACTIVE"|"TP_HIT"|"SL_HIT"|"EXPIRED";
export function checkTradeStatus(s:Signal,p:number,now=Date.now()):TradeStatus{const v=isSignalStillValid(s,p,now);if(v.reason==="expired_ttl")return"EXPIRED";if(v.reason==="sl_hit")return"SL_HIT";if(v.reason==="tp_hit")return"TP_HIT";return"ACTIVE";}
export interface HoldResult{shouldHold:boolean;reason:string;managementState:"STAY"|"EXIT";recommendation:"STAY IN TRADE"|"EXIT TRADE";newStop?:number}
export function shouldHold(s:Signal,c:Candle[],p:number,now=Date.now(),lastExitAlertAt?:number):HoldResult{
 void lastExitAlertAt;const closed=[...c].sort((a,b)=>a.timestamp-b.timestamp).slice(0,-1);
 if(closed.length<22)return{shouldHold:true,reason:"insufficient_closed_4h_history",managementState:"STAY",recommendation:"STAY IN TRADE"};
 const v=isSignalStillValid(s,p,now);if(!v.valid)return{shouldHold:false,reason:v.reason,managementState:"EXIT",recommendation:"EXIT TRADE"};
 const dailyTrend=trend1D(aggregateTo1D(c)),rev=(s.direction==="LONG"&&dailyTrend.direction==="SHORT")||(s.direction==="SHORT"&&dailyTrend.direction==="LONG"),profit=s.direction==="LONG"?p>s.entry:p<s.entry;
 if(rev&&!profit)return{shouldHold:false,reason:"daily_trend_reversal_unprofitable",managementState:"EXIT",recommendation:"EXIT TRADE"};
 const st=stochRsi(c.map(x=>x.close)),opposite=s.direction==="LONG"?st.k<20:st.k>80;
 if(opposite)return{shouldHold:false,reason:"stoch_extreme_opposite_exit",managementState:"EXIT",recommendation:"EXIT TRADE"};
 return{shouldHold:true,reason:"thesis_intact",managementState:"STAY",recommendation:"STAY IN TRADE"};
}

