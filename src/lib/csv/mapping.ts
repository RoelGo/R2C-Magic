import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EnrichedBook } from "@/types/book";
import { type MappingConfig, mappingConfigSchema } from "./mapping-schema";

/**
 * Loads and validates `mapping.config.json` (or any path passed in).
 * Cached after first load; call `reloadMappingConfig()` to force a reread,
 * e.g. after the in-app mapping editor saves.
 */
let _cached: MappingConfig | undefined;
let _cachedPath: string | undefined;

const DEFAULT_PATH = resolve(process.cwd(), "mapping.config.json");

export function loadMappingConfig(path: string = DEFAULT_PATH): MappingConfig {
  if (_cached && _cachedPath === path) return _cached;
  const raw = readFileSync(path, "utf8");
  const parsed = mappingConfigSchema.parse(JSON.parse(raw));
  _cached = parsed;
  _cachedPath = path;
  return parsed;
}

export function reloadMappingConfig(path: string = DEFAULT_PATH): MappingConfig {
  _cached = undefined;
  _cachedPath = undefined;
  return loadMappingConfig(path);
}

// ----------------------------------------------------------------------------
// Field resolution
// ----------------------------------------------------------------------------

/**
 * Resolve a dotted path like `enriched.descriptionShort`, `rseries.brand`,
 * `rseries.subcategory.0` against an EnrichedBook. Returns undefined when any
 * segment is missing.
 */
export function resolveFieldPath(book: EnrichedBook, path: string): unknown {
  const [root, ...rest] = path.split(".");

  let cursor: unknown;
  if (root === "enriched") cursor = book;
  else if (root === "rseries") cursor = book.rSeries;
  else return undefined;

  for (const segment of rest) {
    if (cursor == null) return undefined;
    if (segment === "subcategory" && root === "rseries") {
      // rseries.subcategory.<n> -> book.rSeries.subcategories[n]
      cursor = book.rSeries.subcategories;
      continue;
    }
    if (Array.isArray(cursor)) {
      const idx = Number.parseInt(segment, 10);
      if (Number.isNaN(idx)) return undefined;
      cursor = cursor[idx];
    } else if (typeof cursor === "object") {
      cursor = (cursor as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return cursor;
}

// ----------------------------------------------------------------------------
// Transforms
// ----------------------------------------------------------------------------

export function applyTransforms(
  value: unknown,
  transform?: { truncate?: number; stripHtml?: boolean; divide?: number },
): string {
  if (value == null) return "";

  let out: string;
  if (typeof value === "number") {
    let n = value;
    if (transform?.divide) n = n / transform.divide;
    out = String(n);
  } else if (Array.isArray(value)) {
    out = value.join(", ");
  } else {
    out = String(value);
  }

  if (transform?.stripHtml) {
    out = stripHtml(out);
  }
  if (transform?.truncate && out.length > transform.truncate) {
    // Truncate on word boundary when possible, append ellipsis
    const slice = out.slice(0, transform.truncate);
    const lastSpace = slice.lastIndexOf(" ");
    out = lastSpace > transform.truncate * 0.6 ? `${slice.slice(0, lastSpace)}…` : `${slice}…`;
  }
  return out;
}

const HTML_TAG_RE = /<[^>]+>/g;
const WHITESPACE_RE = /\s+/g;

export function stripHtml(s: string): string {
  return s.replace(HTML_TAG_RE, " ").replace(WHITESPACE_RE, " ").trim();
}
