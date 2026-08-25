import type { Metadata } from "next";
import "./globals.css";
import LongTermPortfolio from "@/components/LongTermPortfolio";

export const metadata: Metadata = {
  title: "CXSwitch — Personal Trading Console",
  description: "4H structure, v28 entry architecture and market intelligence for personal trading.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}<LongTermPortfolio /></body>
    </html>
  );
}
