import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  experimental: {
    serverActions: {
      bodySizeLimit: "20mb", // R-series CSVs can be a few MB
    },
  },
  // better-sqlite3 is a native module; keep it external to the server bundle
  serverExternalPackages: ["better-sqlite3"],
};

export default config;
