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
  const closed4h=[...c].sort((a,b)=>a.timestamp-b.timestamp).slice(0,-1);
  const d=daily(closed4h),closes=d.map(x=>x.close);
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
function trend1D(candles1d: Candle[]): { direction: Direction | null; strength: string } {
  const len = candles1d.length;
  if (len < 25) return { direction: null, strength: "WEAK" };

  const closes = candles1d.map(c => c.close);
  const ema5 = ema(closes, 5);
  const ema13 = ema(closes, 13);

  const direction: Direction = ema5[ema5.length - 1] > ema13[ema13.length - 1] ? "LONG" : "SHORT";

  const highs = candles1d.slice(-20).map(c => c.high);
  const lows = candles1d.slice(-20).map(c => c.low);
  const hh = highs[highs.length - 1] > Math.max(...highs.slice(0, -1));
  const ll = lows[lows.length - 1] < Math.min(...lows.slice(0, -1));

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

// --- MAIN SIGNAL ---
export function evaluateGates(
 pair:string,candles4h:Candle[],currentPrice:number,entry1State?:any,entry2AlreadyFired=false,
 activeSignals:Array<{pair:string;direction:"LONG"|"SHORT"}>=[]
):any {
 const closed4h=[...candles4h].sort((a,b)=>a.timestamp-b.timestamp).slice(0,-1);
 const price=currentPrice??closed4h.at(-1)?.close??0;
 const dailyCandles=aggregateTo1D(closed4h),dailyTrend=trend1D(dailyCandles);
 const closes4h=closed4h.map(x=>x.close);
 const st=stochRsi(closes4h),rv=rsi(closes4h),av=adx(closed4h);
 const e5_4h=ema(closes4h,5).at(-1)??0,e13_4h=ema(closes4h,13).at(-1)??0;
 const momentumAligned=dailyTrend.direction==="LONG"?e5_4h>e13_4h:dailyTrend.direction==="SHORT"?e5_4h<e13_4h:false;
 const rsiExhausted=dailyTrend.direction==="LONG"?rv>78:dailyTrend.direction==="SHORT"?rv<22:false;
 const stochVeto=dailyTrend.direction==="LONG"?st.k>95:dailyTrend.direction==="SHORT"?st.k<5:false;
 const turningAgainst=dailyTrend.direction==="LONG"?st.k<st.d:dailyTrend.direction==="SHORT"?st.k>st.d:false;
 const adxExhausted=av>50&&turningAgainst;
 const exhaustion=rsiExhausted?"4H RSI exhaustion":stochVeto?"4H Stoch extreme veto":adxExhausted?"ADX >50 with Stoch turning against":null;
 const filtersPass=!!dailyTrend.direction&&momentumAligned&&!exhaustion;
 const tl=dailyTrend.direction?getTrendline(pair,closed4h,dailyTrend.direction):null;
 const tlPrice=tl?.price??0;
 const dist=tlPrice>0?(price-tlPrice)/tlPrice:Infinity;
 const nearTrendline=Math.abs(dist)<0.012;
 const stochExtreme=dailyTrend.direction==="LONG"?st.k<20:dailyTrend.direction==="SHORT"?st.k>80:false;
 const stochTurning=dailyTrend.direction==="LONG"?st.k>st.d:dailyTrend.direction==="SHORT"?st.k<st.d:false;
 const last=closed4h.at(-1),prev=closed4h.at(-2);
 const beyondTrendline=dailyTrend.direction==="LONG"?price>tlPrice*1.008:dailyTrend.direction==="SHORT"?price<tlPrice*0.992:false;
 const confirming=!!last&&!!prev&&(dailyTrend.direction==="LONG"?last.close>last.open&&last.close>prev.close:dailyTrend.direction==="SHORT"?last.close<last.open&&last.close<prev.close:false);
 const volUp=!!last&&last.volume>avg(closed.slice(-10).map(x=>x.volume))*1.3;
 const ema8_4h=ema(closes4h,8),ema21_4h=ema(closes4h,21);
 const emaAligned=dailyTrend.direction==="LONG"?price>(ema8_4h.at(-1)??0)&&price>(ema21_4h.at(-1)??0):dailyTrend.direction==="SHORT"?price<(ema8_4h.at(-1)??0)&&price<(ema21_4h.at(-1)??0):false;
 const stochMomentum=dailyTrend.direction==="LONG"?st.k>st.d:dailyTrend.direction==="SHORT"?st.k<st.d:false;
 const adxStrong=av>20;
 let rawType:"ENTRY_1"|"ENTRY_2"|"ADD"|null=null;
 const hasEntry1=!!entry1State&&entry1State.direction===dailyTrend.direction;
 const hasEntry2=hasEntry1&&entry2AlreadyFired;
 const hasSameDirectionPosition=activeSignals.some(x=>x.pair===pair&&x.direction===dailyTrend.direction);
 if(filtersPass){
  if(!hasEntry1&&!hasSameDirectionPosition&&nearTrendline&&stochExtreme)rawType="ENTRY_1";
  else if(hasEntry1&&!hasEntry2&&hasSameDirectionPosition&&nearTrendline&&stochTurning&&!stochExtreme)rawType="ENTRY_2";
  else if(hasEntry1&&hasEntry2&&hasSameDirectionPosition&&beyondTrendline&&confirming&&emaAligned&&(volUp||stochMomentum||adxStrong))rawType="ADD";
 }
 const regime=computeRegime(candles4h);
 const missing:string[]=[];
 if(!dailyTrend.direction)missing.push("daily_ema_5_13_unavailable");
 if(!momentumAligned)missing.push("4H EMA5/13 momentum misaligned");
 if(exhaustion)missing.push("Global exhaustion veto: "+exhaustion);
 if(!tl)missing.push("trendline_unavailable");
 if(!nearTrendline&&!beyondTrendline)missing.push("trendline trigger not met");
 if(!stochExtreme&&!stochTurning)missing.push("Stoch trigger not met");
 if(!rawType)missing.push("V28 trigger not met");
 return {
  direction:dailyTrend.direction,zone:null,trendlineSlope:0,
  trendline:tl?{price:tl.price,distancePct:Math.abs(dist)*100,r2:tl.r2,reason:"V28 shared pair trendline"}:null,
  alignment:{daily:dailyTrend.direction,dailyE5:ema(dailyCandles.map(x=>x.close),5).at(-1)??0,dailyE13:ema(dailyCandles.map(x=>x.close),13).at(-1)??0,fourHE5:e5_4h,fourHE13:e13_4h,fourH:e5_4h>e13_4h?"LONG":e5_4h<e13_4h?"SHORT":null,regime:regime.state,sizeMultiplier:regime.sizeMultiplier,momentumAligned,exhaustion},
  momentumAligned,exhaustion,filtersPass,
  trigger:{entry1:rawType==="ENTRY_1",entry2:rawType==="ENTRY_2",add:rawType==="ADD",signalType:rawType,nearTrendline,stochExtreme,stochTurning,beyondTrendline,confirming,emaAligned,volUp,stochMomentum,adxStrong,entry1Reason:rawType==="ENTRY_1"?"V28 trendline proximity + Stoch extreme + global filters":missing.join("; "),entry2Reason:rawType==="ENTRY_2"?"V28 trendline proximity + Stoch turn + global filters":"not_ready"},
  stopCalc:null,missing:[...new Set(missing)],allPassed:!!rawType&&filtersPass&&!!tl,dailyTransition:false,breakoutRecord:undefined
 };
}

export function generateSignal(pair:string,candles1h:Candle[],candles4h:Candle[],candles15m:Candle[],currentPrice?:number,nowOverride?:number,lastBreakout?:any,entry1State?:any,entry2AlreadyFired=false,activeSignals:Array<{pair:string;direction:"LONG"|"SHORT"}>=[]):SignalResult{
 void candles1h;void candles15m;void lastBreakout;
 const debug:string[]=[],closed4h=[...candles4h].sort((a,b)=>a.timestamp-b.timestamp).slice(0,-1),now=nowOverride??Date.now();
 if(closed4h.length<30){debug.push("[WAIT] Insufficient CLOSED 4H candle data");return{market:getMarketSnapshot(pair,candles1h,candles4h,candles15m),debug};}
 const dailyCandles=aggregateTo1D(closed4h),dailyTrend=trend1D(dailyCandles),regime=computeRegime(candles4h);
 debug.push("[DAILY] EMA5/13="+(dailyTrend.direction??"NONE")+" | size="+Math.round(regime.sizeMultiplier*100)+"%");
 if(!dailyTrend.direction){debug.push("[WAIT] Daily EMA5/13 direction unavailable");return{market:getMarketSnapshot(pair,candles1h,candles4h,candles15m),debug};}
 const price=currentPrice??closed4h.at(-1)!.close,closes4h=closed4h.map(x=>x.close),st=stochRsi(closes4h),rv=rsi(closes4h),av=adx(closed4h);
 const e5_4h=ema(closes4h,5).at(-1)??0,e13_4h=ema(closes4h,13).at(-1)??0;
 const momentumAligned=dailyTrend.direction==="LONG"?e5_4h>e13_4h:dailyTrend.direction==="SHORT"?e5_4h<e13_4h:false;
 const rsiExhausted=dailyTrend.direction==="LONG"?rv>78:dailyTrend.direction==="SHORT"?rv<22:false;
 const stochVeto=dailyTrend.direction==="LONG"?st.k>95:dailyTrend.direction==="SHORT"?st.k<5:false;
 const turningAgainst=dailyTrend.direction==="LONG"?st.k<st.d:dailyTrend.direction==="SHORT"?st.k>st.d:false;
 const adxExhausted=av>50&&turningAgainst;
 const exhaustion=rsiExhausted?"4H RSI exhaustion":stochVeto?"4H Stoch extreme veto":adxExhausted?"ADX >50 with Stoch turning against":null;
 const filtersPass=!!dailyTrend.direction&&momentumAligned&&!exhaustion;
 const tl=getTrendline(pair,closed4h,dailyTrend.direction),tlPrice=tl?.price??0;
 const dist=tlPrice>0?(price-tlPrice)/tlPrice:Infinity;
 const nearTrendline=Math.abs(dist)<0.012;
 const stochExtreme=dailyTrend.direction==="LONG"?st.k<20:st.k>80;
 const stochTurning=dailyTrend.direction==="LONG"?st.k>st.d:st.k<st.d;
 const last=closed4h.at(-1)!,prev=closed4h.at(-2)!;
 const beyondTrendline=dailyTrend.direction==="LONG"?price>tlPrice*1.008:price<tlPrice*0.992;
 const confirming=dailyTrend.direction==="LONG"?last.close>last.open&&last.close>prev.close:last.close<last.open&&last.close<prev.close;
 const volUp=last.volume>avg(closed4h.slice(-10).map(x=>x.volume))*1.3;
 const ema8_4h=ema(closes4h,8),ema21_4h=ema(closes4h,21);
 const emaAligned=dailyTrend.direction==="LONG"?price>(ema8_4h.at(-1)??0)&&price>(ema21_4h.at(-1)??0):price<(ema8_4h.at(-1)??0)&&price<(ema21_4h.at(-1)??0);
 const stochMomentum=dailyTrend.direction==="LONG"?st.k>st.d:st.k<st.d;
 const adxStrong=av>20;
 let rawType:"ENTRY_1"|"ENTRY_2"|"ADD"|null=null;
 const hasEntry1=!!entry1State&&entry1State.direction===dailyTrend.direction;
 const hasEntry2=hasEntry1&&entry2AlreadyFired;
 const hasSameDirectionPosition=activeSignals.some(x=>x.pair===pair&&x.direction===dailyTrend.direction);
 if(filtersPass){
  if(!hasEntry1&&!hasSameDirectionPosition&&nearTrendline&&stochExtreme)rawType="ENTRY_1";
  else if(hasEntry1&&!hasEntry2&&hasSameDirectionPosition&&nearTrendline&&stochTurning&&!stochExtreme)rawType="ENTRY_2";
  else if(hasEntry1&&hasEntry2&&hasSameDirectionPosition&&beyondTrendline&&confirming&&emaAligned&&(volUp||stochMomentum||adxStrong))rawType="ADD";
 }
 if(!filtersPass)debug.push("[GLOBAL FILTER VETO] "+(!momentumAligned?"4H EMA5/13 momentum misaligned":exhaustion??"direction unavailable"));
 if(!tl)debug.push("[WAIT] Shared pair trendline unavailable");
 if(!rawType){debug.push("[WAIT] No V28 trendline/Stoch trigger");return{market:getMarketSnapshot(pair,candles1h,candles4h,candles15m),debug};}
 debug.push("[TRIGGER] "+rawType+" "+dailyTrend.direction);
 const hyst=getHysteresis(pair,now);
 if(hyst.lastSignalType===rawType&&hyst.lastSignalPrice>0){const move=Math.abs(price-hyst.lastSignalPrice)/hyst.lastSignalPrice;if(move<HYSTERESIS_BAND){debug.push("[WAIT] Hysteresis lock "+rawType);return{market:getMarketSnapshot(pair,candles1h,candles4h,candles15m),debug};}}
 if(rawType!==hyst.lastSignalType)setHysteresis(pair,rawType,price,now);
 if(!tl)return{debug:["[SIGNAL BLOCKED] trendline unavailable"]};
 const signalTl=tl;
 const avalue=atr(closed4h,14),recent=closed4h.slice(-20);
 if(!Number.isFinite(avalue)||avalue<=0)return{debug:["[SIGNAL BLOCKED] invalid ATR"]};
 const low=Math.min(...recent.map(x=>x.low)),high=Math.max(...recent.map(x=>x.high));let stop:number,target:number;
 if(rawType==="ENTRY_1"||rawType==="ENTRY_2"){stop=dailyTrend.direction==="LONG"?Math.min(low,price-2*avalue):Math.max(high,price+2*avalue);target=dailyTrend.direction==="LONG"?price+5*avalue:price-5*avalue;}
 else{stop=dailyTrend.direction==="LONG"?Math.min(signalTl.price*0.995,price-1.5*avalue):Math.max(signalTl.price*1.005,price+1.5*avalue);const floor=dailyTrend.direction==="LONG"?price+(price-stop)*MIN_RR:price-(stop-price)*MIN_RR;target=dailyTrend.direction==="LONG"?Math.max(high,floor):Math.min(low,floor);}
 const rr=dailyTrend.direction==="LONG"?(target-price)/(price-stop):(price-target)/(stop-price);
 if(!Number.isFinite(rr)||rr<MIN_RR)return{debug:["[SIGNAL BLOCKED] R:R "+rr.toFixed(2)+" < "+MIN_RR]};
 const size=regime.sizeMultiplier===0.5?0.5:1;
 const signal:Signal={id:pair+"_"+rawType+"_"+now,pair,direction:dailyTrend.direction,type:rawType,signalClass:"TREND",sizeMultiplier:size,entry:Math.round(price*100)/100,stop:Math.round(stop*100)/100,tp1:Math.round(target*100)/100,tp2:Math.round(target*100)/100,rr:Math.round(rr*100)/100,adx:Math.round(av*10)/10,rsi:Math.round(rv*10)/10,stochK:st.k,stochD:st.d,expectedMove:Math.round(Math.abs(target-price)/price*1000)/10,reason:dailyTrend.direction+" "+rawType+" | Daily EMA5/13 + V28 trendline/Stoch trigger + global momentum/exhaustion filters | "+regime.state,timestamp:now,version:CURRENT_SIGNAL_VERSION,context:{targetCount:1,targetAtrMultiple:5,regime:regime.state,regimeSizeMultiplier:size,trendlinePrice:signalTl.price,trendlineR2:signalTl.r2,ema5_1d:ema(dailyCandles.map(x=>x.close),5).at(-1)??0,ema13_1d:ema(dailyCandles.map(x=>x.close),13).at(-1)??0,ema5_4h:e5_4h,ema13_4h:e13_4h,momentumAligned,exhaustion}};
 debug.push("[STOP] "+signal.stop+" | V28 swing/ATR stop");debug.push("[TARGET] "+signal.tp1+" | V28 ATR/swing target; TP2 mirrors TP1");debug.push("[SIGNAL] "+signal.direction+" "+signal.type+" entry="+signal.entry+" SL="+signal.stop+" TP="+signal.tp1+" RR="+signal.rr);
 return{signal,market:getMarketSnapshot(pair,candles1h,candles4h,candles15m),debug};
}

// --- MARKET SNAPSHOT ---
// --- MARKET SNAPSHOT ---
export function getMarketSnapshot(pair:string,candles1h:Candle[],candles4h:Candle[],candles15m:Candle[]):any{
 void candles1h;void candles15m;
 const closed4h=[...candles4h].sort((a,b)=>a.timestamp-b.timestamp).slice(0,-1),completedDaily=aggregateTo1D(closed4h),t=trend1D(completedDaily),reg=computeRegime(candles4h),q=closed4h.map(x=>x.close),dq=completedDaily.map(x=>x.close);
 const st=stochRsi(q),st1=stochRsi(dq);
 const e5=ema(q,5).at(-1)??0,e13=ema(q,13).at(-1)??0,e8=ema(q,8).at(-1)??0,e21=ema(q,21).at(-1)??0;
 const d5=ema(dq,5).at(-1)??0,d8=ema(dq,8).at(-1)??0,d13=ema(dq,13).at(-1)??0,d21=ema(dq,21).at(-1)??0;
 const direction=t.direction??null;
 const momentumAligned=direction==="LONG"?e5>e13:direction==="SHORT"?e5<e13:false;
 const rv=rsi(q),av=adx(closed4h);
 const rsiExhausted=direction==="LONG"?rv>78:direction==="SHORT"?rv<22:false;
 const stochVeto=direction==="LONG"?st.k>95:direction==="SHORT"?st.k<5:false;
 const turningAgainst=direction==="LONG"?st.k<st.d:direction==="SHORT"?st.k>st.d:false;
 const adxExhausted=av>50&&turningAgainst;
 const exhaustion=rsiExhausted?"4H RSI exhaustion":stochVeto?"4H Stoch extreme veto":adxExhausted?"ADX >50 with Stoch turning against":null;
 const storedTrendline=trendlineStore.get(pair),tl=storedTrendline?{price:storedTrendline.slope*(closed4h.length-1)+storedTrendline.intercept,r2:0.85,age:Date.now()-storedTrendline.lastUpdated}:null,price=closed4h.at(-1)?.close??0;
 const trendlineDistancePct=tl&&tl.price>0?Math.abs(price-tl.price)/tl.price*100:null;
 return{pair,price,timestamp:Date.now(),trend:reg.state,regime:reg.state,dailyDirection:direction,dailyStrength:t.strength,dailyClose:dq.at(-1)??0,dailyE5:d5,dailyE8:d8,dailyE13:d13,dailyE21:d21,ema5_1d:d5,ema8_1d:d8,ema13_1d:d13,ema21_1d:d21,ema5_4h:e5,ema13_4h:e13,ema8_4h:e8,ema21_4h:e21,fourHTacticalDirection:e5>e13?"BULL":e5<e13?"BEAR":"NEUTRAL",fourHDirection:e8>e21?"BULL":e8<e21?"BEAR":"NEUTRAL",trendlineDistancePct,stochK:st.k,stochD:st.d,stochK4h:st.k,stochD4h:st.d,stochK1d:st1.k,stochD1d:st1.d,adx:av,rsi:rv,trendlinePrice:tl?.price??0,distToTrendline:trendlineDistancePct,sizeMultiplier:reg.sizeMultiplier,momentumAligned,exhaustion,strategyStatus:"V28 — DAILY EMA5/13 "+(direction??"UNAVAILABLE")};
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
 const dailyTrend=trend1D(aggregateTo1D(closed)),rev=(s.direction==="LONG"&&dailyTrend.direction==="SHORT")||(s.direction==="SHORT"&&dailyTrend.direction==="LONG"),profit=s.direction==="LONG"?p>s.entry:p<s.entry;
 if(rev&&!profit)return{shouldHold:false,reason:"daily_trend_reversal_unprofitable",managementState:"EXIT",recommendation:"EXIT TRADE"};
 const st=stochRsi(closed.map(x=>x.close)),opposite=s.direction==="LONG"?st.k<20:st.k>80;
 if(opposite)return{shouldHold:false,reason:"stoch_extreme_opposite_exit",managementState:"EXIT",recommendation:"EXIT TRADE"};
 return{shouldHold:true,reason:"thesis_intact",managementState:"STAY",recommendation:"STAY IN TRADE"};
}

