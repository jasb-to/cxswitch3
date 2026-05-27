import { Signal } from "@/lib/engine";

async function getSignals(): Promise<Signal[]> {
  try {
    const res = await fetch("http://localhost:3000/api/signals", {
      next: { revalidate: 30 },
      headers: { "cache-control": "no-cache" },
    });
    const data = await res.json();
    return data.signals || [];
  } catch (error) {
    console.error("Failed to fetch signals:", error);
    return [];
  }
}

export default async function Page() {
  const signals = await getSignals();

  return (
    <div className="min-h-screen bg-black text-gray-100 p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-12">
          <h1 className="text-4xl font-bold text-white mb-2">Trading Signals</h1>
          <p className="text-gray-400">Real-time LONG/SHORT positions</p>
        </div>

        {/* Signals Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {signals.map((signal) => (
            <SignalCard key={signal.symbol} signal={signal} />
          ))}
        </div>

        {/* Empty State */}
        {signals.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            No signals available
          </div>
        )}
      </div>
    </div>
  );
}

function SignalCard({ signal }: { signal: Signal }) {
  const isLong = signal.state === "LONG";
  const isShort = signal.state === "SHORT";
  const isFlat = signal.state === "FLAT";

  // Color scheme: Bullish (green) for LONG, Bearish (red) for SHORT, Grey for FLAT
  const borderColor = isLong ? "border-green-700" : isShort ? "border-red-700" : "border-gray-700";
  const bgColor = isLong ? "bg-gradient-to-br from-green-950 to-black" : isShort ? "bg-gradient-to-br from-red-950 to-black" : "bg-gradient-to-br from-gray-900 to-black";
  const stateColor = isLong ? "text-green-400" : isShort ? "text-red-400" : "text-gray-400";
  const confidenceColor = signal.confidence >= 70 ? "text-green-400" : signal.confidence >= 50 ? "text-yellow-400" : "text-gray-400";

  return (
    <div className={`${bgColor} border-2 ${borderColor} rounded-lg p-6 hover:shadow-lg hover:shadow-gray-700/20 transition-all`}>
      {/* Symbol and State */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h2 className="text-2xl font-bold text-white">{signal.symbol}</h2>
          <span className={`px-3 py-1 rounded text-sm font-semibold ${isLong ? "bg-green-900/40 text-green-400" : isShort ? "bg-red-900/40 text-red-400" : "bg-gray-800 text-gray-400"}`}>
            {signal.state}
          </span>
        </div>
        <div className="text-right">
          <p className={`text-lg font-bold ${stateColor}`}>${signal.price.toFixed(2)}</p>
          <p className={`text-sm font-semibold ${confidenceColor}`}>{signal.confidence}% confidence</p>
        </div>
      </div>

      {/* Price Levels */}
      <div className="space-y-3 mb-6">
        <div className="flex justify-between items-center">
          <span className="text-gray-400 text-sm">Entry</span>
          <span className={`font-mono font-semibold ${stateColor}`}>${signal.entry.toFixed(2)}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-gray-400 text-sm">Take Profit</span>
          <span className="font-mono font-semibold text-green-400">${signal.takeProfit.toFixed(2)}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-gray-400 text-sm">Stop Loss</span>
          <span className="font-mono font-semibold text-red-400">${signal.stopLoss.toFixed(2)}</span>
        </div>
      </div>

      {/* Risk/Reward */}
      <div className="bg-gray-900/50 rounded p-3">
        <div className="text-xs text-gray-500 mb-2">Risk/Reward</div>
        <div className="flex justify-between items-center">
          <span className="text-gray-300 text-sm">
            {isFlat ? "N/A" : `${((signal.takeProfit - signal.entry) / Math.abs(signal.entry - signal.stopLoss)).toFixed(2)}:1 RR`}
          </span>
          <span className="text-gray-500 text-xs">{new Date(signal.updatedAt).toLocaleTimeString()}</span>
        </div>
      </div>
    </div>
  );
}
