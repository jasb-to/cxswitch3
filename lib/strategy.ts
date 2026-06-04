export type Symbol = “BTC” | “ETH” | “SOL”;

export type SignalState = “EARLY” | “SNIPER” | “WAIT”;

export interface Candle {
time: number;
open: number;
high: number;
low: number;
close: number;
volume: number;
}

export interface Signal {
symbol: Symbol;
price: number;

state: SignalState;

bias: “LONG” | “SHORT” | “NEUTRAL”;
confidence: number;

adx: number;
stochK: number;
stochD: number;
rsi: number;

reason: string;

stopLoss: number | null;
takeProfit: number | null;
rr: number | null;

expectedMove: number;

updatedAt: string;
}

/* –––––––– UTILS –––––––– */

const clamp = (n: number, min: number, max: number) =>
Math.max(min, Math.min(max, n));

const round = (n: number, d = 2) =>
Math.round(n * 10 ** d) / 10 ** d;

/* –––––––– EMA –––––––– */

function ema(values: number[], period = 21) {
const multiplier = 2 / (period + 1);

let result = values[0];

for (let i = 1; i < values.length; i++) {
result =
values[i] * multiplier +
result * (1 - multiplier);
}

return result;
}

/* –––––––– RSI –––––––– */

function rsi(closes: number[]) {
let gain = 0;
let loss = 0;

for (let i = 1; i < closes.length; i++) {
const diff = closes[i] - closes[i - 1];

if (diff > 0) gain += diff;
else loss -= diff;

}

const rs = gain / (loss || 1);

return 100 - 100 / (1 + rs);
}

/* –––––––– ADX –––––––– */

function adx(candles: Candle[]) {
let plus = 0;
let minus = 0;

for (let i = 1; i < candles.length; i++) {
const upMove =
candles[i].high - candles[i - 1].high;

const downMove =
  candles[i - 1].low - candles[i].low;
if (upMove > downMove && upMove > 0)
  plus += upMove;
if (downMove > upMove && downMove > 0)
  minus += downMove;

}

const total = plus + minus || 1;

return (
Math.abs(plus - minus) /
total
) * 100;
}

/* –––––––– STOCH –––––––– */

function stochKD(
closes: number[],
period = 14
) {
const slice = closes.slice(-period);

const high = Math.max(…slice);
const low = Math.min(…slice);

const k =
((closes.at(-1)! - low) /
(high - low || 1)) *
100;

const prevSlice =
closes.slice(-period - 3, -3);

const prevHigh =
Math.max(…prevSlice);

const prevLow =
Math.min(…prevSlice);

const prevK =
((prevSlice.at(-1)! - prevLow) /
(prevHigh - prevLow || 1)) *
100;

const d =
(k + prevK + prevK) / 3;

return {
k,
d,
prevK,
};
}

/* –––––––– VOLUME –––––––– */

function volumeScore(
candles: Candle[]
) {
const vols = candles.map(
c => c.volume
);

const avg =
vols.reduce((a, b) => a + b, 0) /
vols.length;

const last = vols.at(-1)!;

const ratio =
last / (avg || 1);

return {
ratio,
spike: ratio > 1.25,
};
}

/* –––––––– BOS –––––––– */

function BOS(candles: Candle[]) {
const last = candles.at(-1)!;
const prev = candles.at(-2)!;
const prev2 = candles.at(-3)!;

if (
last.high > prev.high &&
prev.high > prev2.high
)
return “BULL”;

if (
last.low < prev.low &&
prev.low < prev2.low
)
return “BEAR”;

return “NEUTRAL”;
}

/* –––––––– CORE –––––––– */

export function generateSignal(
symbol: Symbol,
price: number,
candles15m: Candle[],
candles1h: Candle[]
): Signal {

const closes15 =
candles15m.map(c => c.close);

const closes1h =
candles1h.map(c => c.close);

const r = rsi(closes15);

const {
k,
d,
prevK,
} = stochKD(closes15);

const a = adx(candles15m);

const vol =
volumeScore(candles15m);

const bos =
BOS(candles15m);

/* –––––––– REAL 1H TREND –––––––– */

const emaNow =
ema(closes1h, 21);

const emaPrev =
ema(
closes1h.slice(0, -1),
21
);

const slope =
emaNow - emaPrev;

const slopePct =
Math.abs(
(slope / emaNow) * 100
);

let bias:
| “LONG”
| “SHORT”
| “NEUTRAL” =
“NEUTRAL”;

if (
slope > 0 &&
slopePct > 0.05
)
bias = “LONG”;

if (
slope < 0 &&
slopePct > 0.05
)
bias = “SHORT”;

/* –––––––– CHOP FILTER –––––––– */

const trendValid =
a > 22 &&
bias !== “NEUTRAL”;

/* –––––––– TIMING ONLY –––––––– */

const bullishCross =
prevK < d &&
k > d;

const bearishCross =
prevK > d &&
k < d;

const longPullback =
bias === “LONG” &&
k < 30 &&
bullishCross;

const shortPullback =
bias === “SHORT” &&
k > 70 &&
bearishCross;

/* –––––––– EARLY –––––––– */

const early =
trendValid &&
(longPullback ||
shortPullback) &&
vol.ratio > 1.05 &&
r > 40 &&
r < 70;

/* –––––––– SNIPER –––––––– */

const sniper =
early &&
a > 27 &&
vol.spike &&
(
(bias === “LONG” &&
bos === “BULL”) ||
(bias === “SHORT” &&
bos === “BEAR”)
);

const state: SignalState =
sniper
? “SNIPER”
: early
? “EARLY”
: “WAIT”;

/* –––––––– CONFIDENCE –––––––– */

let confidence = 20;

if (state === “EARLY”) {
confidence =
60 +
Math.min(
10,
slopePct * 50
) +
Math.min(
10,
a / 3
);
}

if (state === “SNIPER”) {
confidence =
80 +
Math.min(
8,
slopePct * 50
) +
Math.min(
8,
a / 4
);
}

confidence =
clamp(
confidence,
20,
96
);

/* –––––––– MOVE –––––––– */

const expectedMove =
state === “SNIPER”
? 0.06
: state === “EARLY”
? 0.04
: 0.01;

let sl: number | null =
null;

let tp: number | null =
null;

if (
state !== “WAIT”
) {
const risk =
expectedMove * 0.55;

if (bias === "LONG") {
  sl =
    price *
    (1 - risk);
  tp =
    price *
    (1 + expectedMove);
}
if (
  bias === "SHORT"
) {
  sl =
    price *
    (1 + risk);
  tp =
    price *
    (1 - expectedMove);
}

}

const rr =
sl && tp
? Math.abs(
(tp - price) /
(price - sl)
)
: null;

return {
symbol,
price: round(price),

state,
bias,
confidence:
  round(confidence),
adx: round(a),
stochK: round(k),
stochD: round(d),
rsi: round(r),
reason:
  state === "SNIPER"
    ? "SNIPER CONFIRMED (1H EMA21 + BOS + VOLUME)"
    : state === "EARLY"
    ? "EARLY PULLBACK ENTRY (1H TREND)"
    : "NO STRUCTURE",
stopLoss:
  sl
    ? round(sl)
    : null,
takeProfit:
  tp
    ? round(tp)
    : null,
rr:
  rr
    ? round(rr)
    : null,
expectedMove:
  round(
    expectedMove * 100
  ),
updatedAt:
  new Date().toISOString(),

};
}
