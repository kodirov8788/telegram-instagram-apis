import "./globals.css";
import type { Metadata } from "next";
import { Inter } from "next/font/google";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

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
    <html lang="en" className={inter.variable}>
      <body className="antialiased bg-background text-foreground min-h-screen font-sans">
        {children}
      </body>
    </html>
  );
}
