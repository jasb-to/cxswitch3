// ─── UI Alert Banner ─────────────────────────────────────────────────────

function UIAlertBanner({ alert }: { alert: UIAlert }) {
  const isShortAlert = alert.type === "SHORT_ALERT_OVERSOLD_CROSS";
  const color = isShortAlert ? "border-emerald-500/50 bg-emerald-950/20" : "border-rose-500/50 bg-rose-950/20";
  const icon = isShortAlert ? "↗️" : "↘️";
  const title = isShortAlert ? "Potential Bounce" : "Potential Pullback";

  return (
    <div className={`rounded-xl border ${color} p-4 mb-4`}>
      <div className="flex items-center gap-3">
        <span className="text-xl">{icon}</span>
        <div className="flex-1">
          <p className="text-sm font-semibold text-white">
            {alert.pair} — {title}
          </p>
          <p className="text-xs text-slate-400 mt-1">
            {alert.message}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Stoch K={alert.stochK.toFixed(1)} D={alert.stochD.toFixed(1)} • {timeAgo(alert.timestamp)} ago
          </p>
        </div>
      </div>
    </div>
  );
}
