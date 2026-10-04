const KRAKEN_API_URL = "https://api.kraken.com";

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

let lastReq = 0;
const MIN_MS = 1000;

async function rateFetch(url: string, opts?: RequestInit): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastReq;
  if (elapsed < MIN_MS) await new Promise(r => setTimeout(r, MIN_MS - elapsed));
  lastReq = Date.now();
  return fetch(url, opts);
}

export async function getCandles(pair: string, interval: number = 60, since?: number): Promise<Candle[]> {
  const defaultSince = Math.floor((Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000);
  const url = new URL(`${KRAKEN_API_URL}/0/public/OHLC`);
  url.searchParams.set("pair", pair);
  url.searchParams.set("interval", String(interval));
  url.searchParams.set("since", String(since ?? defaultSince));
  const res = await rateFetch(url.toString());
  if (!res.ok) throw new Error(`Kraken OHLC HTTP ${res.status}`);
  const data = await res.json();
  if (data.error?.length > 0) throw new Error(`Kraken OHLC error: ${data.error.join(", ")}`);
  const key = Object.keys(data.result).find(k => k !== "last");
  if (!key) throw new Error("No OHLC data");
  const raw = data.result[key];
  if (!Array.isArray(raw)) throw new Error(`OHLC not array: ${typeof raw}`);

  const intervalMs = interval * 60 * 1000;
  const now = Date.now();
  if (raw.length > 0) {
    const lastCandleTime = raw[raw.length - 1][0] * 1000;
    if (lastCandleTime + intervalMs > now) raw.pop();
  }

  return raw.map((c: any) => ({
    timestamp: c[0] * 1000,
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[6]),
  }));
}

export async function getCurrentPrice(pair: string): Promise<number> {
  const url = `${KRAKEN_API_URL}/0/public/Ticker?pair=${encodeURIComponent(pair)}`;
  const res = await rateFetch(url);
  if (!res.ok) throw new Error(`Kraken Ticker HTTP ${res.status}`);
  const data = await res.json();
  if (data.error?.length > 0) throw new Error(`Kraken Ticker error: ${data.error.join(", ")}`);
  const key = Object.keys(data.result)[0];
  return parseFloat(data.result[key].c[0]);
}

export function krakenPairFormat(pair: string): string {
  const map: Record<string, string> = {
    "BTC/USD": "XBTUSD",
    "ETH/USD": "ETHUSD",
    "SOL/USD": "SOLUSD",
    "HYPE/USD": "HYPEUSD",
    "DOGE/USD": "DOGEUSD",
    "LINK/USD": "LINKUSD",
    "AVAX/USD": "AVAXUSD",
    "ZEC/USD": "ZECUSD",
  };
  return map[pair] || pair.replace("/", "");
}

export function aggregateTo1D(candles4h: Candle[]): Candle[] {
  if (!candles4h?.length) return [];
  const sorted = [...candles4h].sort((a, b) => a.timestamp - b.timestamp);
  const groups = new Map<string, Candle[]>();
  for (const c of sorted) {
    const key = new Date(c.timestamp).toISOString().split("T")[0];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  const daily: Candle[] = [];
  for (const [, bars] of groups) {
    if (!bars.length) continue;
    daily.push({
      timestamp: bars[0].timestamp,
      open: bars[0].open,
      high: Math.max(...bars.map(b => b.high)),
      low: Math.min(...bars.map(b => b.low)),
      close: bars[bars.length - 1].close,
      volume: bars.reduce((s, b) => s + b.volume, 0),
    });
  }
  return daily.sort((a, b) => a.timestamp - b.timestamp);
}

// Kraken Futures private API
const KRAKEN_FUTURES_URL = "https://futures.kraken.com/derivatives/api/v3";

function futuresAuthent(endpointPath:string, postData:string, nonce:string, secret:string):string {
  const crypto = require("crypto");
  const encoded = postData;
  const sha = crypto.createHash("sha256").update(encoded + nonce + endpointPath).digest();
  return crypto.createHmac("sha512", Buffer.from(secret, "base64")).update(sha).digest("base64");
}

async function futuresPrivatePost(path:string, params:Record<string,string|number|boolean>):Promise<any> {
  const apiKey=process.env.KRAKEN_FUTURES_API_KEY;
  const secret=process.env.KRAKEN_FUTURES_API_SECRET;
  if(!apiKey||!secret) throw new Error("Kraken Futures API credentials are not configured");
  const nonce=String(Date.now());
  const postData=new URLSearchParams(Object.entries(params).map(([k,v])=>[k,String(v)])).toString();
  const endpointPath=path.replace("/derivatives","");
  const res=await rateFetch(KRAKEN_FUTURES_URL+path,{
    method:"POST",
    headers:{
      "APIKey":apiKey,
      "Authent":futuresAuthent(endpointPath,postData,nonce,secret),
      "Nonce":nonce,
      "Content-Type":"application/x-www-form-urlencoded",
      "Accept":"application/json",
    },
    body:postData,
  });
  if(!res.ok) throw new Error(`Kraken Futures HTTP ${res.status}`);
  const data=await res.json();
  if(data?.result==="error"||data?.error) throw new Error(`Kraken Futures order error: ${data.error||JSON.stringify(data)}`);
  return data;
}

async function futuresPrivateGet(path:string):Promise<any> {
  const apiKey=process.env.KRAKEN_FUTURES_API_KEY;
  const secret=process.env.KRAKEN_FUTURES_API_SECRET;
  if(!apiKey||!secret) throw new Error("Kraken Futures API credentials are not configured");
  const nonce=String(Date.now());
  const endpointPath=path.replace("/derivatives","");
  const postData="";
  const res=await rateFetch(KRAKEN_FUTURES_URL+path,{
    method:"GET",
    headers:{
      "APIKey":apiKey,
      "Authent":futuresAuthent(endpointPath,postData,nonce,secret),
      "Nonce":nonce,
      "Accept":"application/json",
    },
  });
  if(!res.ok) throw new Error(`Kraken Futures HTTP ${res.status}`);
  const data=await res.json();
  if(data?.result==="error"||data?.error) throw new Error(`Kraken Futures error: ${data.error||JSON.stringify(data)}`);
  return data;
}

export function isExchangeSyncConfigured():boolean {
  return Boolean(process.env.KRAKEN_FUTURES_API_KEY && process.env.KRAKEN_FUTURES_API_SECRET);
}

export interface FuturesPosition {
  symbol:string;
  side:"LONG"|"SHORT";
  size:number;
  entryPrice:number;
}

export async function getFuturesPositions():Promise<FuturesPosition[]> {
  const data=await futuresPrivateGet("/openpositions");
  if(!Array.isArray(data?.openPositions)) {
    throw new Error("Kraken Futures response missing openPositions array");
  }
  return data.openPositions.map((p:any)=>({
    symbol:String(p.symbol||"").toUpperCase(),
    side:String(p.side||"").toLowerCase()==="long"?"LONG":"SHORT",
    size:Number(p.size||0),
    entryPrice:Number(p.price||0),
  })).filter((p:FuturesPosition)=>p.symbol&&Number.isFinite(p.size)&&p.size>0);
}

// Compatibility name retained for callers during the migration; it now reads Futures, never Spot.
export async function getExchangePositions():Promise<FuturesPosition[]> {
  return getFuturesPositions();
}
export async function placeFuturesReduceOnlyMarketOrder(pair:string,direction:"LONG"|"SHORT",size:number):Promise<{orderId?:string;symbol:string;requestedSize:number;remainingSize:number}> {
  if(!Number.isFinite(size)||size<0) throw new Error("Invalid Futures order size");
  const positions=await getFuturesPositions();
  const expectedSide=direction==="LONG"?"LONG":"SHORT";
  const position=positions.find(p=>pairFromFuturesSymbolForOrder(p.symbol)===pair&&p.side===expectedSide);
  if(!position) throw new Error(`No Kraken Futures ${direction} position found for ${pair}`);
  const closeSide=direction==="LONG"?"sell":"buy";
  const requested=size===0?position.size:Math.min(size,position.size);
  const data=await futuresPrivatePost("/sendorder",{orderType:"mkt",symbol:position.symbol,side:closeSide,size:requested,reduceOnly:true});
  const orderId=data?.sendStatus?.order_id;
  let remaining=position.size;
  for(let i=0;i<8;i++){
    await new Promise(r=>setTimeout(r,750));
    const after=await getFuturesPositions();
    const current=after.find(p=>p.symbol===position.symbol&&p.side===expectedSide);
    remaining=current?.size||0;
    if(remaining<=Math.max(0.00000001,position.size-requested+0.00000001)) break;
  }
  if(remaining>Math.max(0.00000001,position.size-requested+0.00000001)){
    throw new Error(`Kraken Futures order accepted but position size did not confirm: ${position.size} -> ${remaining}`);
  }
  return {orderId,symbol:position.symbol,requestedSize:requested,remainingSize:remaining};
}

function pairFromFuturesSymbolForOrder(symbol:string):string|undefined {
  const s=symbol.toUpperCase().replace(/^(PI|PF)_/,"").replace(/[^A-Z0-9]/g,"");
  const map:Record<string,string>={XBTUSD:"BTC",ETHUSD:"ETH",SOLUSD:"SOL",HYPEUSD:"HYPE",DOGEUSD:"DOGE",LINKUSD:"LINK",AVAXUSD:"AVAX",ZECUSD:"ZEC"};
  return map[s];
}
