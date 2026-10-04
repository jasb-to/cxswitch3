import { NextResponse } from "next/server";
import { getJarvisSnapshot } from "@/lib/jarvis";

export const dynamic="force-dynamic";
export const revalidate=0;

export async function GET(){
  const data=await getJarvisSnapshot();
  return NextResponse.json({
    success:true,
    data,
    verdict:data?.portfolioState||"GOOD",
    pairs:data?.pairs||{},
  });
}
