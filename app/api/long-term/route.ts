import { NextResponse } from "next/server";
import { getLongTermState } from "@/lib/long-term";
export const dynamic="force-dynamic";
export async function GET(){try{return NextResponse.json({success:true,data:await getLongTermState()})}catch(e){console.error("[LONG-TERM] ERROR",e);return NextResponse.json({success:false,error:String(e)},{status:500})}}
