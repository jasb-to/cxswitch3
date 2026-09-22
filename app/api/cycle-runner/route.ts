import {NextResponse} from "next/server";
import {getCycleRunnerState,setCycleRunnerState} from "@/lib/state";
import {getMarketData} from "@/lib/state";

export const dynamic="force-dynamic";
export const revalidate=0;

export async function GET(){
  const state=await getCycleRunnerState();
  const market=await getMarketData();
  const data=Object.fromEntries(["BTC","ETH"].map(pair=>[pair,{...(market.find((m:any)=>m?.pair===pair)?.cycleRunner||{enabled:true,status:"WAITING FOR MAJOR RETEST",direction:"NEUTRAL",leveragePlan:{initial:10,next:15,profitLocked:20,fullProfit:25}}),state:state[pair]||{pair,status:"WATCHING",direction:"NEUTRAL",initialLeverage:10,currentLeverage:10}}]));
  return NextResponse.json({data,updatedAt:Date.now()});
}

export async function POST(req:Request){
  const body=await req.json().catch(()=>({}));
  const pair=body?.pair;
  if(!["BTC","ETH"].includes(pair))return NextResponse.json({error:"BTC or ETH only"},{status:400});
  const all=await getCycleRunnerState();
  if(body.action==="ENTER"){
    const market=(await getMarketData()).find((m:any)=>m?.pair===pair);
    const direction=market?.cycleRunner?.direction||"NEUTRAL";
    all[pair]={pair,status:"IN_POSITION",direction,entry:Number(body.entry||market?.price||0),initialLeverage:10,currentLeverage:10,enteredAt:Date.now(),profitLockStage:0};
  }else if(body.action==="RESET"){
    delete all[pair];
  }else if(body.action==="LEVERAGE"){
    const current=all[pair]; if(!current)return NextResponse.json({error:"No active cycle position"},{status:400});
    const lev=Math.max(10,Math.min(25,Number(body.leverage||10))); current.currentLeverage=lev; current.profitLockStage=lev>=25?3:lev>=20?2:lev>=15?1:0; all[pair]=current;
  }else return NextResponse.json({error:"Unknown action"},{status:400});
  await setCycleRunnerState(all);
  return NextResponse.json({ok:true,state:all[pair]||null});
}
