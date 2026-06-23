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
    <html lang="en">
      <body className="bg-black text-white antialiased min-h-screen">
        {/* Global app container fixes left/right edge issue */}
        <div className="w-full px-6 sm:px-8 lg:px-12">
          <div className="mx-auto max-w-7xl">
            {children}
          </div>
        </div>
      </body>
    </html>
  );
}
 
