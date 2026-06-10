/**
 * Run pending Drizzle migrations against the configured SQLite database.
 * Invoked by `pnpm db:migrate` and on container start.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { config } from "../config";

const dbPath = resolve(process.cwd(), config.DATABASE_URL);
const dbDir = dirname(dbPath);
if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

const sqlite = new Database(dbPath);
sqlite.pragma("foreign_keys = ON");
const db = drizzle(sqlite);

migrate(db, { migrationsFolder: "./src/lib/db/migrations" });

sqlite.close();
console.log(`migrations applied to ${dbPath}`);
