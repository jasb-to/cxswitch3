import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Trading Signals",
  description: "3-Layer Trendline Trading Dashboard",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="bg-black scroll-smooth">
      <body className="bg-black antialiased">{children}</body>
    </html>
  );
}
