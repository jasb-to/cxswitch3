import { NextResponse } from "next/server";
import { getCandles, krakenPairFormat } from "@/lib/kraken";
import { evaluate1DTrend } from "@/lib/1d-trend-engine";
import { get1DTrendState, record1DTrend } from "@/lib/1d-trend-state";
import { send1DTrendFlipAlert } from "@/lib/telegram-1d-trend";
import { getActiveSignals } from "@/lib/state";
export const dynamic="force-dynamic"; export const revalidate=0;
const PAIRS=["BTC","ETH","SOL","HYPE"] as const;
export async function GET(request:Request){
 const secret=request.headers.get("authorization")?.replace(/^Bearer\s+/i,"")||new URL(request.url).searchParams.get("secret");
 if(secret!==process.env.CRON_SECRET)return NextResponse.json({error:"Unauthorized"},{status:401});
 const started=Date.now(); console.log("========================================"); console.log(`[1D EXPERIMENT] Started ${new Date(started).toISOString()} | frozen diagnostic engine | V28 gating=OFF`);
 const active=await getActiveSignals(); const results:any[]=[];
 for(const pair of PAIRS){try{const daily=await getCandles(krakenPairFormat(`${pair}/USD`),1440);if(daily.length<220){console.log(`[1D EXPERIMENT] ${pair} — insufficient daily history: ${daily.length}`);continue;}const result=evaluate1DTrend(daily);const before=(await get1DTrendState())[pair]?.state;const recorded=await record1DTrend(pair,result,active);if(recorded.flip&&before)await send1DTrendFlipAlert(pair,before,recorded.state,result);console.log(`[1D EXPERIMENT] ${pair} — ${recorded.state} | candidate=${result.candidateState} | structure=${result.structure.label} | EMA=${result.ema.alignment} | 5/13=${result.fast513.direction} | ADX=${result.adx} | momentum=${result.momentum.direction}/${result.momentum.state} | price=${result.price}`);results.push({pair,state:recorded.state,candidate:result.candidateState,flip:recorded.flip,price:result.price,structure:result.structure,ema:result.ema,fast513:result.fast513,adx:result.adx,momentum:result.momentum});}catch(error){console.error(`[1D EXPERIMENT] ${pair} ERROR`,error);results.push({pair,error:String(error)});}}
 console.log(`[1D EXPERIMENT] Done pairs=${results.length} duration=${Date.now()-started}ms | V28 untouched`); console.log("========================================"); return NextResponse.json({success:true,experiment:"1D frozen trend engine",startedAt:new Date(started).toISOString(),v28Gating:false,results});
}
