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
    <div className="min-h-screen bg-[#0a0a0a] text-gray-100 p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-12">
          <h1 className="text-4xl font-bold text-white mb-2">3-Layer Trendline Trading</h1>
          <p className="text-gray-400">4H Breaks → 15M Retests → 5M Entry</p>
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

  // Color scheme: Green left border for LONG, Red for SHORT, Grey for FLAT
  const borderColor = isLong ? "border-l-4 border-l-green-500" : isShort ? "border-l-4 border-l-red-500" : "border-l-4 border-l-gray-600";
  const entryPriceColor = isLong ? "text-green-400" : isShort ? "text-red-400" : "text-gray-400";

  return (
    <div className={`bg-[#1a1a1a] ${borderColor} rounded p-6 hover:bg-[#222] transition-colors`}>
      {/* Symbol and State */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h2 className="text-2xl font-bold text-white">{signal.symbol}</h2>
          <span className={`px-3 py-1 rounded text-sm font-semibold ${
            isLong ? "bg-green-950 text-green-300" : isShort ? "bg-red-950 text-red-300" : "bg-gray-800 text-gray-400"
          }`}>
            {signal.state}
          </span>
        </div>
        <div className="text-right">
          <p className="text-sm text-gray-400">Confidence</p>
          <p className={`text-xl font-bold ${signal.confidence >= 70 ? "text-green-400" : signal.confidence >= 50 ? "text-yellow-400" : "text-gray-400"}`}>
            {signal.confidence}%
          </p>
        </div>
      </div>

      {/* Layer Breakdown */}
      <div className="bg-[#121212] rounded p-4 mb-6 space-y-2">
        <div className="text-xs font-mono">
          <div className="flex justify-between text-gray-500">
            <span>Layer 1:</span>
            <span className="text-gray-300">{signal.layer1 || "—"}</span>
          </div>
          <div className="flex justify-between text-gray-500">
            <span>Layer 2:</span>
            <span className="text-gray-300">{signal.layer2 || "—"}</span>
          </div>
          <div className="flex justify-between text-gray-500">
            <span>Layer 3:</span>
            <span className="text-gray-300">{signal.layer3 || "—"}</span>
          </div>
        </div>
      </div>

      {/* Price Levels */}
      {!isFlat && (
        <div className="space-y-3 mb-6">
          <div className="flex justify-between items-center">
            <span className="text-gray-400 text-sm">Entry</span>
            <span className={`font-mono font-semibold ${entryPriceColor}`}>${signal.entry?.toFixed(2)}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-gray-400 text-sm">Take Profit</span>
            <span className="font-mono font-semibold text-green-400">${signal.takeProfit?.toFixed(2)}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-gray-400 text-sm">Stop Loss</span>
            <span className="font-mono font-semibold text-red-400">${signal.stopLoss?.toFixed(2)}</span>
          </div>
          <div className="flex justify-between items-center pt-2 border-t border-gray-700">
            <span className="text-gray-400 text-sm">Risk/Reward</span>
            <span className="font-mono font-semibold text-gray-300">{signal.riskReward?.toFixed(2)}:1</span>
          </div>
        </div>
      )}

      {/* Updated At */}
      <div className="text-xs text-gray-500 text-right">
        {new Date(signal.updatedAt).toLocaleTimeString()}
      </div>
    </div>
  );
}
