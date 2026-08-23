import "./globals.css";
import type { Metadata, Viewport } from "next";
import { GlobalHeader } from "../components/GlobalHeader";
import { BottomNav } from "../components/BottomNav";

export const metadata: Metadata = {
  title: "PolySignal",
  description: "Evidence-first Polymarket microstructure research"
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen w-full bg-background text-foreground font-display selection:bg-primary/20">
        <GlobalHeader />

        <main className="w-full max-w-8xl mx-auto pb-[calc(4rem+env(safe-area-inset-bottom,0px))] md:pb-8">
          {children}
        </main>

        <div className="md:hidden">
          <BottomNav />
        </div>
      </body>
    </html>
  );
}
