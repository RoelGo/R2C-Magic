import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { config } from "../config";
import * as schema from "./schema";

/**
 * Singleton SQLite + Drizzle client. The DB file lives at DATABASE_URL
 * (default `./data/r2c.db`). Parent directory is created on first access.
 */
let _db: ReturnType<typeof drizzle<typeof schema>> | undefined;
let _sqlite: Database.Database | undefined;

export function getDb() {
  if (_db) return _db;

  const dbPath = resolve(process.cwd(), config.DATABASE_URL);
  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

  _sqlite = new Database(dbPath);
  _sqlite.pragma("journal_mode = WAL");
  _sqlite.pragma("foreign_keys = ON");
  _db = drizzle(_sqlite, { schema });
  return _db;
}

export function closeDb() {
  _sqlite?.close();
  _sqlite = undefined;
  _db = undefined;
}
