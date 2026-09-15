import { NextResponse } from "next/server";
import { getIndependentActive, getIndependentHistory } from "@/lib/independentState";
import { getIndependentStrategyConfigs } from "@/lib/independentStrategies";
export async function GET(){return NextResponse.json({strategies:getIndependentStrategyConfigs(),active:await getIndependentActive(),history:(await getIndependentHistory()).slice(-200).reverse()});}
