import type { Metadata } from "next";
import "./globals.css";
import { clearKVOnDeploy } from "@/lib/clear-on-deploy";

export const metadata: Metadata = {
  title: "CX Switch - Trading Signals",
  description: "4H structure + 15M momentum trading system",
};

// v13: Auto-clear KV on deploy — runs once per deploy
// Clears old signals/market_data/active_trades so fresh v13 data starts clean
clearKVOnDeploy().catch(() => {});

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-black text-white antialiased min-h-screen">
        <div className="w-full px-6 sm:px-8 lg:px-12">
          <div className="mx-auto max-w-7xl">
            {children}
          </div>
        </div>
      </body>
    </html>
  );
}
