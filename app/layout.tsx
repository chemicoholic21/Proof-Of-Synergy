import type { Metadata } from "next";
import { Playfair_Display, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import GrainOverlay from "@/components/bits/GrainOverlay";

// Editorial pairing: Playfair Display (serif) for headlines, Inter for body, JetBrains Mono for data.
const display = Playfair_Display({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-display",
});
const sans = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Proof of Synergy - Career Memory",
  description: "Your AI Interview Twin that never forgets - every interview grows a Cognee Career Knowledge Graph.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body className="text-ink antialiased">
        <GrainOverlay />
        {children}
      </body>
    </html>
  );
}
