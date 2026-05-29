import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "CX Switch - Trading Signals",
  description: "4H structure + 15M momentum trading system",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="bg-background">
      <body className="bg-background text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
