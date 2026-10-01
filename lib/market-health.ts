// lib/market-health.ts — broad crypto risk context for CX Switch
// Advisory only: this module never gates a trade by itself.

export type MarketHealth={
  timestamp:number;
  totalMarketCap:number|null;
  totalMarketCapChange24h:number|null;
  btcDominance:number|null;
  btcDominanceChange24h:number|null;
  usdtDominance:number|null;
  usdtDominanceChange24h:number|null;
  btcPriceChange24h:number|null;
  risk:"SUPPORTIVE"|"MIXED"|"DEFENSIVE"|"UNKNOWN";
  altContext:"SUPPORTIVE"|"MIXED"|"DEFENSIVE"|"UNKNOWN";
  reason:string;
};

let cached:{at:number;value:MarketHealth}|null=null;
const CACHE_MS=5*60*1000;
const n=(x:any)=>Number.isFinite(Number(x))?Number(x):null;

export async function getMarketHealth():Promise<MarketHealth>{
  if(cached&&Date.now()-cached.at<CACHE_MS)return cached.value;
  const unknown:MarketHealth={timestamp:Date.now(),totalMarketCap:null,totalMarketCapChange24h:null,btcDominance:null,btcDominanceChange24h:null,usdtDominance:null,usdtDominanceChange24h:null,btcPriceChange24h:null,risk:"UNKNOWN",altContext:"UNKNOWN",reason:"market-health unavailable"};
  try{
    const [globalRes,priceRes]=await Promise.all([
      fetch("https://api.coingecko.com/api/v3/global",{cache:"no-store"}),
      fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,tether&vs_currencies=usd&include_market_cap=true&include_24hr_change=true",{cache:"no-store"})
    ]);
    if(!globalRes.ok||!priceRes.ok)throw new Error("CoinGecko market-health request failed");
    const g=await globalRes.json(),p=await priceRes.json();
    const total=n(g?.data?.total_market_cap?.usd);
    const totalCh=n(g?.data?.market_cap_change_percentage_24h_usd);
    const btcDom=n(g?.data?.market_cap_percentage?.btc);
    const usdtDom=n(g?.data?.market_cap_percentage?.usdt??g?.data?.market_cap_percentage?.tether);
    const btcCh=n(p?.bitcoin?.usd_24h_change);
    const usdtCh=n(p?.tether?.usd_24h_change);
    const btcDomCh=btcCh!==null&&totalCh!==null?btcCh-totalCh:null;
    const usdtDomCh=usdtCh!==null&&totalCh!==null?usdtCh-totalCh:null;
    const risk=totalCh===null?"UNKNOWN":totalCh>1&&((btcDomCh??0)>=0)?"SUPPORTIVE":totalCh<-1?"DEFENSIVE":"MIXED";
    const altSupport=(btcDomCh!==null&&btcDomCh<0)&&(usdtDomCh!==null&&usdtDomCh<=0)&&(totalCh!==null&&totalCh>=0);
    const altDefensive=(usdtDomCh!==null&&usdtDomCh>0)||(totalCh!==null&&totalCh<-1);
    const altContext=altSupport?"SUPPORTIVE":altDefensive?"DEFENSIVE":"MIXED";
    const value:MarketHealth={timestamp:Date.now(),totalMarketCap:total,totalMarketCapChange24h:totalCh,btcDominance:btcDom,btcDominanceChange24h:btcDomCh,usdtDominance:usdtDom,usdtDominanceChange24h:usdtDomCh,btcPriceChange24h:btcCh,risk,altContext,reason:altSupport?"Total market cap firming while BTC/USDT dominance pressure eases":altDefensive?"Stablecoin dominance or total-market weakness signals defensive conditions":"Market breadth/rotation is mixed"};
    cached={at:Date.now(),value}; return value;
  }catch(error){
    console.error("[MARKET HEALTH]",error);
    return unknown;
  }
}
