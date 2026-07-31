import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "YDeck - Telegram & Instagram Customer Communication Agent",
  description: "AI-powered omnichannel customer communication and sales agent",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased bg-slate-900 text-slate-100 min-h-screen">
        {children}
      </body>
    </html>
  );
}
