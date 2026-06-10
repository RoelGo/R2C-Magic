import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "R2C Magic",
  description: "Enrich Lightspeed R-Series book exports for the C-Series webshop.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="border-b border-slate-200 dark:border-slate-800">
          <div className="mx-auto max-w-5xl px-6 py-4">
            <h1 className="text-xl font-semibold">R2C Magic</h1>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              R-Series → C-Series book metadata enricher
            </p>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
