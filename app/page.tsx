{signals
  .filter(
    (signal) =>
      signal &&
      typeof signal.price === "number" &&
      typeof signal.adx === "number"
  )
  .map((signal) => {
    const state = signal.isSniper
      ? "SNIPER"
      : signal.isEarly
      ? "EARLY"
      : "WAIT";

    return (
      <div
        key={signal.symbol}
        className="rounded-2xl border border-gray-800 bg-white/[0.03] p-6"
      >
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-3xl font-bold">
              {signal.symbol}
            </h2>

            <p className="text-gray-400 mt-1">
              ${Number(signal.price || 0).toLocaleString()}
            </p>
          </div>

          <div className="px-3 py-1 rounded-lg border text-sm font-semibold">
            {state}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 mb-5">
          <Metric label="Bias" value={signal.bias || "—"} />

          <Metric
            label="Confidence"
            value={`${signal.confidence ?? 0}%`}
          />
        </div>

        <div className="border-t border-gray-800 pt-4 space-y-3">
          <Row label="ADX" value={(signal.adx ?? 0).toFixed(1)} />
          <Row label="Stoch K" value={(signal.stochK ?? 0).toFixed(1)} />
          <Row label="Stoch D" value={(signal.stochD ?? 0).toFixed(1)} />
        </div>

        <div className="border-t border-gray-800 mt-4 pt-4 space-y-3">
          <Row
            label="SL"
            value={
              signal.stopLoss
                ? `$${signal.stopLoss.toFixed(2)}`
                : "—"
            }
          />

          <Row
            label="TP"
            value={
              signal.takeProfit
                ? `$${signal.takeProfit.toFixed(2)}`
                : "—"
            }
          />
        </div>
      </div>
    );
  })}
