// lib/strategy.ts — v28 "Trendline Break: StochRSI Timing + Position Build"
// ============================================================
// Architecture: stateful trendline, TV-exact StochRSI
// EXIT: Stoch extreme opposite (matches chart)
// ALERTS: ENTRY_1, ENTRY_2 and ADD

import { getTrendlineState, setTrendlineState } from "./state";

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
 reason:string; timestamp:number; version:number; context?:{momentumAligned?:boolean|null;fourHDirection?:Direction|null;[key:string]:any};
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
const MAX_LEVERAGE = 15;
const MAINTENANCE_MARGIN_RATE = 0.01;
type Direction="LONG"|"SHORT";
function daily(c:Candle[]):Candle[]{return aggregateTo1D(c);}
export type RegimeStrength="HIGH"|"MED"|"LOW";
export type RegimeState="BULL_HIGH"|"BULL_MED"|"BULL_LOW"|"CHOP"|"BEAR_LOW"|"BEAR_MED"|"BEAR_HIGH";
export interface ComputedRegime {
  state:RegimeState; direction:Direction|null; sizeMultiplier:0|0.5|1;
  price:number; e21:number; e8:number; e5:number; e13:number; spread:number; spread3:number; spreadDelta:number;
  strength:RegimeStrength|"NEUTRAL";
}
export function computeRegime(c:Candle[]):ComputedRegime {
  const bars=[...c];
  const d=daily(bars),closes=d.map(x=>x.close);
  const neutral:ComputedRegime={state:"CHOP",direction:null,sizeMultiplier:0,price:closes.at(-1)??0,e21:0,e8:0,e5:0,e13:0,spread:0,spread3:0,spreadDelta:0,strength:"NEUTRAL"};
  if(closes.length<22)return neutral;
  // Regime classification and size are macro EMA8/21 based. EMA5/13 is reserved for ENTRY_1 and 4H trade management.
  const e8s=ema(closes,8),e21s=ema(closes,21);
  const price=closes.at(-1)!,e8=e8s.at(-1)!,e21=e21s.at(-1)!;
  const aboveE21=price>e21,emaStack=e8>e21?"BULL":"BEAR";
  const spread=(e8-e21)/price*100;
  const spread3=closes.length>=25?(e8s.at(-4)!-e21s.at(-4)!)/closes.at(-4)!*100:spread;
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
  return{state,direction,sizeMultiplier,price,e21,e8,e5:e8,e13:e21,spread,spread3,spreadDelta,strength:direction?strength:"NEUTRAL"};
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
  // Migrate old pair:FAST|MACRO:DIRECTION keys into one shared trendline per pair.
  // Prefer the former MACRO line because the shared line is oriented by daily EMA 8/21.
  const selected = new Map<string, { data: unknown; priority: number; updated: number }>();
  for (const [key, data] of Object.entries(state)) {
    const legacy = key.match(/^(.*):(FAST|MACRO):(LONG|SHORT)$/);
    const pair = legacy?.[1] ?? key;
    const priority = legacy ? (legacy[2] === "MACRO" ? 2 : 1) : 3;
    const updated = Number((data as any)?.lastUpdated ?? 0);
    const previous = selected.get(pair);
    if (!previous || priority > previous.priority || (priority === previous.priority && updated > previous.updated)) selected.set(pair, { data, priority, updated });
  }
  for (const [pair, value] of selected) trendlineStore.set(pair, value.data as TrendlineState);
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
  
  const stateKey = pair;
  const existing = trendlineStore.get(stateKey);
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
  
  trendlineStore.set(stateKey, {
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
// Daily EMA8/21 is the macro direction for ENTRY_2 and ADD.
function trend1D(candles1d: Candle[]): { direction: Direction | null; strength: string } {
  const len = candles1d.length;
  if (len < 25) return { direction: null, strength: "WEAK" };
  const closes = candles1d.map(c => c.close);
  const e8 = ema(closes, 8), e21 = ema(closes, 21);
  const direction: Direction = e8.at(-1)! > e21.at(-1)! ? "LONG" : "SHORT";
  const highs = candles1d.slice(-20).map(c => c.high);
  const lows = candles1d.slice(-20).map(c => c.low);
  const hh = highs.at(-1)! > Math.max(...highs.slice(0, -1));
  const ll = lows.at(-1)! < Math.min(...lows.slice(0, -1));
  const strength = (direction === "LONG" && hh) || (direction === "SHORT" && ll) ? "STRONG" : "MEDIUM";
  return { direction, strength };
}

// ENTRY_1 alone uses the faster daily EMA5/13 direction.
function trend1DEarly(candles1d: Candle[]): { direction: Direction | null; strength: string } {
  const len = candles1d.length;
  if (len < 25) return { direction: null, strength: "WEAK" };
  const closes = candles1d.map(c => c.close);
  const e5 = ema(closes, 5), e13 = ema(closes, 13);
  const direction: Direction = e5.at(-1)! > e13.at(-1)! ? "LONG" : "SHORT";
  const highs = candles1d.slice(-20).map(c => c.high);
  const lows = candles1d.slice(-20).map(c => c.low);
  const hh = highs.at(-1)! > Math.max(...highs.slice(0, -1));
  const ll = lows.at(-1)! < Math.min(...lows.slice(0, -1));
  const strength = (direction === "LONG" && hh) || (direction === "SHORT" && ll) ? "STRONG" : "MEDIUM";
  return { direction, strength };
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

// --- MAIN SIGNAL ---
export function evaluateGates(pair:string,candles4h:Candle[],currentPrice:number,activeSignals:Array<{pair:string;direction:"LONG"|"SHORT";type?:string}>=[]):any {
 const bars=[...candles4h],price=currentPrice??bars.at(-1)?.close??0;
 const dailyCandles=aggregateTo1D(bars),macro=trend1D(dailyCandles),fast=trend1DEarly(dailyCandles);
 const closes=bars.map(x=>x.close),st=stochRsi(closes),av=adx(bars);
 // One shared 4H trendline, oriented by daily EMA 8/21 macro direction.
 const trendline=macro.direction?getTrendline(pair,bars,macro.direction):null;
 const trendlineDist=trendline&&trendline.price>0?(price-trendline.price)/trendline.price:Infinity;
 const nearTrendline=!!trendline&&Math.abs(trendlineDist)<0.012;
 const stochExtremeFast=fast.direction==="LONG"?st.k<20:fast.direction==="SHORT"?st.k>80:false;
 const stochTurningMacro=macro.direction==="LONG"?st.k>st.d:macro.direction==="SHORT"?st.k<st.d:false;
 const stochExtremeMacro=macro.direction==="LONG"?st.k<20:macro.direction==="SHORT"?st.k>80:false;
 const hardCapFast=fast.direction==="LONG"?st.k>95:fast.direction==="SHORT"?st.k<5:false;
 const hardCapMacro=macro.direction==="LONG"?st.k>95:macro.direction==="SHORT"?st.k<5:false;
 const e5=ema(closes,5).at(-1)??0,e13=ema(closes,13).at(-1)??0;
 const fourHDirection=e5>e13?"LONG":e5<e13?"SHORT":null;
 const entry1MomentumAligned=!!fast.direction&&fourHDirection===fast.direction;
 const entry2MomentumAligned=!!macro.direction&&fourHDirection===macro.direction;
 const nearFast=nearTrendline,nearMacro=nearTrendline;
 const entry1Ready=!!fast.direction&&nearFast&&stochExtremeFast&&!hardCapFast&&entry1MomentumAligned;
 const entry2Ready=!!macro.direction&&nearMacro&&stochTurningMacro&&!stochExtremeMacro&&!hardCapMacro&&entry2MomentumAligned;
 const last=bars.at(-1),prev=bars.at(-2);
 const beyond=macro.direction==="LONG"?!!trendline&&price>trendline.price*1.008:macro.direction==="SHORT"?!!trendline&&price<trendline.price*0.992:false;
 const confirming=!!last&&!!prev&&(macro.direction==="LONG"?last.close>last.open&&last.close>prev.close:macro.direction==="SHORT"?last.close<last.open&&last.close<prev.close:false);
 const e8=ema(closes,8),e21=ema(closes,21);
 const emaAligned=macro.direction==="LONG"?price>(e8.at(-1)??0)&&price>(e21.at(-1)??0):macro.direction==="SHORT"?price<(e8.at(-1)??0)&&price<(e21.at(-1)??0):false;
 const momentumAligned=!!macro.direction&&fourHDirection===macro.direction;
 const activePairPosition=activeSignals.some(x=>x.pair===pair);
 const activeMatch=!!macro.direction&&activeSignals.some(x=>x.pair===pair&&x.direction===macro.direction);
 const entry2Continuation=activeMatch&&activeSignals.some(x=>x.pair===pair&&x.direction===macro.direction&&x.type==="ENTRY_1");
 const volUp=!!last&&last.volume>avg(bars.slice(-10).map(x=>x.volume))*1.3;
 const stochMomentum=macro.direction==="LONG"?st.k>st.d:macro.direction==="SHORT"?st.k<st.d:false;
 const adxStrong=av>20;
 let rawType:"ENTRY_1"|"ENTRY_2"|"ADD"|null=null,direction:Direction|null=null;
 if(entry1Ready&&!activePairPosition){rawType="ENTRY_1";direction=fast.direction;}
 else if(entry2Ready&&(!activePairPosition||entry2Continuation)){rawType="ENTRY_2";direction=macro.direction;}
 else if(activeMatch&&macro.direction&&trendline&&beyond&&confirming&&emaAligned&&(volUp||stochMomentum||adxStrong)&&!hardCapMacro){rawType="ADD";direction=macro.direction;}
 const hardCap=rawType==="ENTRY_1"?hardCapFast:hardCapMacro,regime=computeRegime(bars),missing:string[]=[];
 if(!macro.direction)missing.push("daily EMA8/21 unavailable for shared 4H trendline");
 if(!trendline)missing.push("shared 4H trendline unavailable");
 if(!nearTrendline)missing.push("outside 1.2% shared trendline proximity");
 if(!fast.direction)missing.push("ENTRY_1 daily EMA5/13 unavailable");
 if(!stochExtremeFast)missing.push("ENTRY_1 Stoch extreme not met");
 if(!stochTurningMacro)missing.push("ENTRY_2 Stoch turn not met");
 if(fast.direction&&!entry1MomentumAligned)missing.push("WAIT — 4H EMA5/13 momentum misaligned with daily trend (ENTRY_1)");
 if(macro.direction&&!entry2MomentumAligned)missing.push("WAIT — 4H EMA5/13 momentum misaligned with daily trend (ENTRY_2)");
 if(!activeMatch)missing.push("ADD requires an active same-direction position");
 if(hardCap)missing.push("hard Stoch exhaustion cap");
 if(!rawType)missing.push("V28 stage trigger not met");
 return {direction,zone:null,trendlineSlope:0,trendline:trendline?{price:trendline.price,distancePct:Math.abs(trendlineDist)*100,r2:trendline.r2,reason:"V28 shared 4H trendline"}:null,alignment:{daily:macro.direction,entry1Daily:fast.direction,fourH:fourHDirection,regime:regime.state,sizeMultiplier:regime.sizeMultiplier,momentumAligned,exhaustion:hardCap?"Stoch hard cap":null},momentumAligned,exhaustion:hardCap?"Stoch hard cap":null,filtersPass:!hardCap,trigger:{entry1:rawType==="ENTRY_1",entry2:rawType==="ENTRY_2",add:rawType==="ADD",signalType:rawType,nearTrendline,stochExtreme:stochExtremeFast,stochTurning:stochTurningMacro,beyondTrendline:beyond,confirming,emaAligned,volUp,stochMomentum,adxStrong,entry1Reason:entry1Ready?"Daily EMA5/13 + shared 4H trendline proximity + Stoch extreme + 4H EMA5/13 alignment":(!entry1MomentumAligned?"WAIT — 4H EMA5/13 momentum misaligned with daily trend":"not_ready"),entry2Reason:entry2Ready?"Daily EMA8/21 + shared 4H trendline proximity + Stoch turn + 4H EMA5/13 alignment":(!entry2MomentumAligned?"WAIT — 4H EMA5/13 momentum misaligned with daily trend":"not_ready"),entry1MomentumAligned,entry2MomentumAligned},stopCalc:null,missing:[...new Set(missing)],allPassed:!!rawType};
}
export function generateSignal(pair:string,candles1h:Candle[],candles4h:Candle[],candles15m:Candle[],currentPrice?:number,nowOverride?:number,lastBreakout?:any,_entry1State?:any,_entry2AlreadyFired=false,_activeSignals:Array<{pair:string;direction:"LONG"|"SHORT";type?:string}>=[]):SignalResult{
 void candles1h;void candles15m;void lastBreakout;void _entry1State;void _entry2AlreadyFired;
 const debug:string[]=[],bars=[...candles4h],now=nowOverride??Date.now();
 if(bars.length<30){debug.push("[WAIT] Insufficient 4H candle data");return{market:getMarketSnapshot(pair,candles1h,candles4h,candles15m),debug};}
 const dailyCandles=aggregateTo1D(bars),macro=trend1D(dailyCandles),fast=trend1DEarly(dailyCandles),regime=computeRegime(bars);
 debug.push("[DAILY] EMA8/21="+(macro.direction??"NONE")+" | ENTRY_1 EMA5/13="+(fast.direction??"NONE")+" | size="+Math.round(regime.sizeMultiplier*100)+"%");
 const price=currentPrice??bars.at(-1)!.close,close=bars.at(-1)!.close,closes=bars.map(x=>x.close),st=stochRsi(closes),rv=rsi(closes),av=adx(bars);
 const trendline=macro.direction?getTrendline(pair,bars,macro.direction):null;
 const trendlinePrice=trendline?.price??0;
 const trendlineDist=trendlinePrice>0?(price-trendlinePrice)/trendlinePrice:Infinity;
 const nearTrendline=!!trendline&&Math.abs(trendlineDist)<0.012;
 const stochExtremeFast=fast.direction==="LONG"?st.k<20:fast.direction==="SHORT"?st.k>80:false;
 const stochTurningMacro=macro.direction==="LONG"?st.k>st.d:macro.direction==="SHORT"?st.k<st.d:false;
 const stochExtremeMacro=macro.direction==="LONG"?st.k<20:macro.direction==="SHORT"?st.k>80:false;
 const hardCapFast=fast.direction==="LONG"?st.k>95:fast.direction==="SHORT"?st.k<5:false;
 const hardCapMacro=macro.direction==="LONG"?st.k>95:macro.direction==="SHORT"?st.k<5:false;
 const e5_4h=ema(closes,5).at(-1)??0,e13_4h=ema(closes,13).at(-1)??0;
 const fourHDirection=e5_4h>e13_4h?"LONG":e5_4h<e13_4h?"SHORT":null;
 const entry1MomentumAligned=!!fast.direction&&fourHDirection===fast.direction;
 const entry2MomentumAligned=!!macro.direction&&fourHDirection===macro.direction;
 const nearFast=nearTrendline,nearMacro=nearTrendline;
 const entry1Eligible=!!fast.direction&&nearFast&&stochExtremeFast&&!hardCapFast&&entry1MomentumAligned;
 const entry2Eligible=!!macro.direction&&nearMacro&&stochTurningMacro&&!stochExtremeMacro&&!hardCapMacro&&entry2MomentumAligned;
 const last=bars.at(-1)!,prev=bars.at(-2)!;
 const beyondTrendline=macro.direction==="LONG"?!!trendline&&price>trendlinePrice*1.008:macro.direction==="SHORT"?!!trendline&&price<trendlinePrice*0.992:false;
 const confirming=macro.direction==="LONG"?last.close>last.open&&last.close>prev.close:macro.direction==="SHORT"?last.close<last.open&&last.close<prev.close:false;
 const ema8_4h=ema(closes,8),ema21_4h=ema(closes,21);
 const emaAligned=macro.direction==="LONG"?price>(ema8_4h.at(-1)??0)&&price>(ema21_4h.at(-1)??0):macro.direction==="SHORT"?price<(ema8_4h.at(-1)??0)&&price<(ema21_4h.at(-1)??0):false;
 const momentumAligned=!!macro.direction&&fourHDirection===macro.direction;
 const activePairPosition=_activeSignals.some(x=>x.pair===pair);
 const activeMatch=!!macro.direction&&_activeSignals.some(x=>x.pair===pair&&x.direction===macro.direction);
 const entry2Continuation=activeMatch&&_activeSignals.some(x=>x.pair===pair&&x.direction===macro.direction&&x.type==="ENTRY_1");
 const volUp=last.volume>avg(bars.slice(-10).map(x=>x.volume))*1.3;
 const stochMomentum=macro.direction==="LONG"?st.k>st.d:macro.direction==="SHORT"?st.k<st.d:false;
 const adxStrong=av>20;
 let rawType:"ENTRY_1"|"ENTRY_2"|"ADD"|null=null;
 let rawDirection:Direction|null=null;
 if(entry1Eligible&&!activePairPosition){rawType="ENTRY_1";rawDirection=fast.direction;}
 else if(entry2Eligible&&(!activePairPosition||entry2Continuation)){rawType="ENTRY_2";rawDirection=macro.direction;}
 else if(activeMatch&&macro.direction&&trendline&&beyondTrendline&&confirming&&emaAligned&&(volUp||stochMomentum||adxStrong)&&!hardCapMacro){rawType="ADD";rawDirection=macro.direction;}
 debug.push(`[V28] ${pair} | Daily=${macro.direction} Fast=${fast.direction} | Shared 4H TL=${trendlinePrice.toFixed(2)} Dist=${(trendlineDist*100).toFixed(2)}% | Stoch=${st.k} | Type=${rawType}`);
 if(fast.direction&&!entry1MomentumAligned)debug.push("[WAIT] 4H EMA5/13 momentum misaligned with daily trend — ENTRY_1 blocked (Daily Fast="+fast.direction+", 4H="+(fourHDirection??"NEUTRAL")+")");
 if(macro.direction&&!entry2MomentumAligned)debug.push("[WAIT] 4H EMA5/13 momentum misaligned with daily trend — ENTRY_2 blocked (Daily Macro="+macro.direction+", 4H="+(fourHDirection??"NEUTRAL")+")");
 if(rawType)debug.push("[TRIGGER] "+rawType+" "+rawDirection);
 const finalType=rawType; // Valid setups fire without a price-movement hysteresis lock.
 if(!finalType){debug.push("[WAIT] No V28 shared-trendline/Stoch trigger");return{market:getMarketSnapshot(pair,candles1h,candles4h,candles15m),debug};}
 const signalDirection:Direction|null=finalType==="ENTRY_1"?fast.direction:macro.direction;
 if(!signalDirection){debug.push("[WAIT] No directional EMA bias available");return{market:getMarketSnapshot(pair,candles1h,candles4h,candles15m),debug};}
 const finalHardCap=signalDirection==="LONG"?st.k>95:st.k<5;
 if(finalHardCap){debug.push("[WAIT] Stoch hard exhaustion cap for "+signalDirection);return{market:getMarketSnapshot(pair,candles1h,candles4h,candles15m),debug};}
 const signalTl=trendline;
 if(!signalTl)return{debug:["[SIGNAL BLOCKED] shared 4H trendline unavailable"]};
 const avalue=atr(bars,14),recent=bars.slice(-20);
 if(!Number.isFinite(avalue)||avalue<=0)return{debug:["[SIGNAL BLOCKED] invalid ATR"]};
 const low=Math.min(...recent.map(x=>x.low)),high=Math.max(...recent.map(x=>x.high));let stop:number,target:number;
 if(finalType==="ENTRY_1"||finalType==="ENTRY_2"){stop=signalDirection==="LONG"?Math.min(low,price-2*avalue):Math.max(high,price+2*avalue);target=signalDirection==="LONG"?price+5*avalue:price-5*avalue;}
 else{stop=signalDirection==="LONG"?Math.min(signalTl.price*0.995,price-1.5*avalue):Math.max(signalTl.price*1.005,price+1.5*avalue);const floor=signalDirection==="LONG"?price+(price-stop)*MIN_RR:price-(stop-price)*MIN_RR;target=signalDirection==="LONG"?Math.max(high,floor):Math.min(low,floor);}
 // Qualify the setup against the original V28 swing/ATR stop before applying
 // the 15x liquidation safety clamp. The clamp protects the live stop; it must
 // not retroactively invalidate a setup that passed V28's original MIN_RR gate.
 const originalStop=stop;
 const originalRisk=signalDirection==="LONG"?price-originalStop:originalStop-price;
 const originalReward=signalDirection==="LONG"?target-price:price-target;
 const originalRr=originalRisk>0?originalReward/originalRisk:NaN;
 if(!Number.isFinite(originalRr)||originalRr<MIN_RR){
  return{debug:["[SIGNAL BLOCKED] R:R "+originalRr.toFixed(2)+" < "+MIN_RR]};
 }

 // Keep the actual protective stop inside the configured 15x liquidation buffer.
 const liquidationPrice=signalDirection==="LONG"
  ? price*(1-1/MAX_LEVERAGE+MAINTENANCE_MARGIN_RATE)
  : price*(1+1/MAX_LEVERAGE-MAINTENANCE_MARGIN_RATE);
 if(signalDirection==="LONG"&&stop<liquidationPrice)stop=liquidationPrice;
 else if(signalDirection==="SHORT"&&stop>liquidationPrice)stop=liquidationPrice;
 const stopClamped=stop!==originalStop;
 const actualRisk=signalDirection==="LONG"?price-stop:stop-price;
 const actualReward=signalDirection==="LONG"?target-price:price-target;
 const actualRr=actualRisk>0?actualReward/actualRisk:NaN;
 if(!Number.isFinite(actualRr)||actualRisk<=0||actualReward<=0){
  return{debug:["[SIGNAL BLOCKED] Invalid protected trade risk/reward"]};
 }
 if(stopClamped)debug.push("[STOP] Clamped to 15x liquidation buffer: "+stop.toFixed(2)+" (was "+originalStop.toFixed(2)+")");
 debug.push("[RR] Original V28 R:R="+originalRr.toFixed(2)+" | Protected trade R:R="+actualRr.toFixed(2));
 const size=regime.sizeMultiplier===0.5?0.5:1;
 const signal:Signal={id:pair+"_"+finalType+"_"+now,pair,direction:signalDirection!,type:finalType,signalClass:"TREND",sizeMultiplier:size,entry:Math.round(price*100)/100,stop:Math.round(stop*100)/100,tp1:Math.round(target*100)/100,tp2:Math.round(target*100)/100,rr:Math.round(actualRr*100)/100,adx:Math.round(av*10)/10,rsi:Math.round(rv*10)/10,stochK:st.k,stochD:st.d,expectedMove:Math.round(Math.abs(target-price)/price*1000)/10,reason:signalDirection+" "+finalType+" | "+(finalType==="ENTRY_1"?"Daily EMA5/13 early direction":"Daily EMA8/21 direction")+" + V28 trigger | "+regime.state,timestamp:now,version:CURRENT_SIGNAL_VERSION,context:{targetCount:1,targetAtrMultiple:5,regime:regime.state,regimeSizeMultiplier:size,trendlinePrice:signalTl.price,trendlineR2:signalTl.r2,dailyDirection:macro.direction,entry1Direction:fast.direction,dailyE8_1d:ema(dailyCandles.map(x=>x.close),8).at(-1)??0,dailyE21_1d:ema(dailyCandles.map(x=>x.close),21).at(-1)??0,entry1E5_1d:ema(dailyCandles.map(x=>x.close),5).at(-1)??0,entry1E13_1d:ema(dailyCandles.map(x=>x.close),13).at(-1)??0,ema5_4h:e5_4h,ema13_4h:e13_4h,fourHDirection,momentumAligned,exhaustion:finalHardCap?"Stoch hard cap":null}};
 debug.push("[STOP] "+signal.stop+" | V28 swing/ATR stop");debug.push("[TARGET] "+signal.tp1+" | V28 ATR/swing target; TP2 mirrors TP1");debug.push("[SIGNAL] "+signal.direction+" "+signal.type+" entry="+signal.entry+" SL="+signal.stop+" TP="+signal.tp1+" RR="+signal.rr);
 return{signal,market:getMarketSnapshot(pair,candles1h,candles4h,candles15m),debug};
}

// --- MARKET SNAPSHOT ---
// --- MARKET SNAPSHOT ---
export function getMarketSnapshot(pair:string,candles1h:Candle[],candles4h:Candle[],candles15m:Candle[]):any{
 void candles1h;void candles15m;
 const bars=[...candles4h],dailyCandles=aggregateTo1D(bars),macro=trend1D(dailyCandles),fast=trend1DEarly(dailyCandles),reg=computeRegime(bars),q=bars.map(x=>x.close),dq=dailyCandles.map(x=>x.close);
 const st=stochRsi(q),st1=stochRsi(dq),e5=ema(q,5).at(-1)??0,e13=ema(q,13).at(-1)??0,e8=ema(q,8).at(-1)??0,e21=ema(q,21).at(-1)??0;
 const d5=ema(dq,5).at(-1)??0,d8=ema(dq,8).at(-1)??0,d13=ema(dq,13).at(-1)??0,d21=ema(dq,21).at(-1)??0;
 const direction=macro.direction??null,entry1Direction=fast.direction??null,fourHDirection=e5>e13?"LONG":e5<e13?"SHORT":null;
 const momentumAligned=direction?fourHDirection===direction:null,rv=rsi(q),av=adx(bars);
 const hardCap=direction==="LONG"?st.k>95:direction==="SHORT"?st.k<5:false;
 const tl=direction?getTrendline(pair,bars,direction):null,price=bars.at(-1)?.close??0,trendlineDistancePct=tl&&tl.price>0?Math.abs(price-tl.price)/tl.price*100:null;
 return{pair,price,timestamp:Date.now(),trend:reg.state,regime:reg.state,dailyDirection:macro.direction??null,entry1Direction:fast.direction??null,alignedDirection:macro.direction??null,dailyStrength:macro.strength,dailyClose:dq.at(-1)??0,dailyE5:d5,dailyE8:d8,dailyE13:d13,dailyE21:d21,ema5_1d:d5,ema8_1d:d8,ema13_1d:d13,ema21_1d:d21,ema5_4h:e5,ema13_4h:e13,ema8_4h:e8,ema21_4h:e21,fourHTacticalDirection:fourHDirection??"NEUTRAL",fourHDirection:fourHDirection??"NEUTRAL",trendlineDistancePct,stochK:st.k,stochD:st.d,stochK4h:st.k,stochD4h:st.d,stochK1d:st1.k,stochD1d:st1.d,adx:av,rsi:rv,trendlinePrice:tl?.price??0,distToTrendline:trendlineDistancePct,sizeMultiplier:reg.sizeMultiplier,momentumAligned,exhaustion:hardCap?"Stoch hard cap":null,strategyStatus:"V28 — DAILY EMA8/21 "+(direction??"UNAVAILABLE")+" | ENTRY_1 EMA5/13 "+(entry1Direction??"UNAVAILABLE")};
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
export interface HoldResult{shouldHold:boolean;reason:string;managementState:"STAY"|"EXIT";recommendation:"STAY IN TRADE"|"EXIT TRADE";newStop?:number;fourHDirection:Direction|null;momentumAligned:boolean|null;profitable:boolean|null}
export function shouldHold(s:Signal,c:Candle[],p:number,now=Date.now(),lastExitAlertAt?:number):HoldResult{
  void lastExitAlertAt;
  const bars=[...c];
  const fallbackDirection=s.context?.fourHDirection??null;
  const fallbackAligned=typeof s.context?.momentumAligned==="boolean"?s.context.momentumAligned:null;
  if(bars.length<22)return{shouldHold:true,reason:"insufficient_4h_history",managementState:"STAY",recommendation:"STAY IN TRADE",fourHDirection:fallbackDirection,momentumAligned:fallbackAligned,profitable:null};
  const closes=bars.map(x=>x.close),e5=ema(closes,5).at(-1)??0,e13=ema(closes,13).at(-1)??0;
  const fourHDirection:Direction|null=e5>e13?"LONG":e5<e13?"SHORT":null;
  const momentumAligned=fourHDirection===null?null:fourHDirection===s.direction;
  const profitable=s.direction==="LONG"?p>s.entry:p<s.entry;
  const state={fourHDirection,momentumAligned,profitable};
  const v=isSignalStillValid(s,p,now);
  if(!v.valid)return{shouldHold:false,reason:v.reason,managementState:"EXIT",recommendation:"EXIT TRADE",...state};
  const dailyTrend=trend1D(aggregateTo1D(bars)),dailyReversed=(s.direction==="LONG"&&dailyTrend.direction==="SHORT")||(s.direction==="SHORT"&&dailyTrend.direction==="LONG");
  if(dailyReversed&&!profitable)return{shouldHold:false,reason:"daily_ema8_21_reversed_unprofitable",managementState:"EXIT",recommendation:"EXIT TRADE",...state};
  // Exit only when StochRSI reaches the opposite extreme to the entry direction.
  // LONG entries use the oversold extreme (K < 20), so exit at overbought (K > 80).
  // SHORT entries use the overbought extreme (K > 80), so exit at oversold (K < 20).
  const st=stochRsi(closes),opposite=s.direction==="LONG"?st.k>80:st.k<20;
  if(opposite)return{shouldHold:false,reason:"stoch_extreme_opposite_exit",managementState:"EXIT",recommendation:"EXIT TRADE",...state};
  if(momentumAligned===false){
    if(profitable)return{shouldHold:true,reason:"4h_ema5_13_misaligned_daily_ema8_21_still_valid_tighten_stop_to_entry",managementState:"STAY",recommendation:"STAY IN TRADE",newStop:s.entry,...state};
    return{shouldHold:false,reason:"4h_ema5_13_misaligned_unprofitable_exit",managementState:"EXIT",recommendation:"EXIT TRADE",...state};
  }
  return{shouldHold:true,reason:"4h_momentum_and_daily_macro_valid",managementState:"STAY",recommendation:"STAY IN TRADE",...state};
}

