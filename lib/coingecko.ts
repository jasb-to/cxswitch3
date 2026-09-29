// lib/coingecko.ts — CoinGecko market data fallback for assets without a Kraken spot pair
import type { Candle } from "./kraken";

const BASE="https://api.coingecko.com/api/v3";
const API_KEY=process.env.COINGECKO_API_KEY;

async function cgFetch(url:string):Promise<any>{
  const headers:Record<string,string>={"accept":"application/json"};
  if(API_KEY) headers["x-cg-demo-api-key"]=API_KEY;
  const res=await fetch(url,{headers,cache:"no-store"});
  if(!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  return res.json();
}

export async function getCoinGeckoPrice(id:string):Promise<number>{
  const data=await cgFetch(`${BASE}/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd`);
  const price=Number(data?.[id]?.usd);
  if(!Number.isFinite(price)||price<=0) throw new Error(`CoinGecko price unavailable for ${id}`);
  return price;
}

export async function getCoinGeckoDailyCandles(id:string,days=730):Promise<Candle[]>{
  const data=await cgFetch(`${BASE}/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${days}`);
  const prices:Array<[number,number]>=Array.isArray(data?.prices)?data.prices:[];
  const volumes:Array<[number,number]>=Array.isArray(data?.total_volumes)?data.total_volumes:[];
  if(!prices.length) return [];
  const volumeAt=(ts:number)=>volumes.length?Number(volumes.reduce((best,row)=>Math.abs(row[0]-ts)<Math.abs(best[0]-ts)?row:best,volumes[0])[1]||0):0;
  const out:Candle[]=[];
  for(let i=0;i<prices.length;i++){
    const [ts,close]=prices[i];
    const prev=i>0?prices[i-1][1]:close;
    const open=prev;
    const high=Math.max(open,close);
    const low=Math.min(open,close);
    out.push({timestamp:Number(ts),open:Number(open),high:Number(high),low:Number(low),close:Number(close),volume:volumeAt(ts)});
  }
  return out.filter(x=>x.timestamp+24*60*60*1000<=Date.now()).sort((a,b)=>a.timestamp-b.timestamp);
}
