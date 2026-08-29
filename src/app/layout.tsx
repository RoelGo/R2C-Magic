import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "R2C Magic",
  description: "Enrich Lightspeed book CSVs (R-Series or CB intake) for the C-Series webshop.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="border-b border-slate-200 dark:border-slate-800">
          <div className="mx-auto max-w-5xl px-6 py-4">
            <h1 className="text-xl font-semibold">R2C Magic</h1>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              R-Series / CB intake → C-Series book metadata enricher
            </p>
            <nav className="mt-3 flex gap-4 text-sm font-medium">
              <Link
                href="/"
                className="text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
              >
                Bulk upload
              </Link>
              <Link
                href="/intake"
                className="text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
              >
                New arrivals
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
