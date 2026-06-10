/**
 * Canonical Book type — the lingua franca between uploaded CSV rows (in any
 * supported input format), online enrichment sources, and the C-series writer.
 *
 * `ean` is the join key across all sources. The raw upload row lives on
 * `source` as a discriminated union — `source.kind` tells the mapping engine
 * which dotted-path root (`rseries.*` or `cb.*`) is valid for this book.
 * Enriched fields are unprefixed and tracked per-field via `fieldSources`.
 */
export type EnrichmentSourceId = "google-books" | "open-library" | "kb-sru" | "cb" | "r-series";

/**
 * Identifies which kind of CSV the user uploaded. Distinct from
 * EnrichmentSourceId — the latter names *online* data sources used during
 * enrichment, this names *input file shapes* the parser knows.
 */
export type InputFormat = "r-series" | "cb-intake";

export interface BookDimensionsMm {
  x?: number;
  y?: number;
  z?: number;
}

export interface RSeriesRow {
  systemId: string;
  upc?: string;
  ean: string;
  customSku?: string;
  manufactSku?: string;
  item: string;
  vendorId?: string;
  qty?: number;
  price?: string;
  tax?: string;
  brand?: string;
  publishToEcom?: string;
  season?: string;
  department?: string;
  msrp?: string;
  taxClass?: string;
  defaultCost?: string;
  vendor?: string;
  category?: string;
  subcategories: string[]; // 1..9
}

/**
 * One row in the rokko CB-intake spreadsheet (Google Sheets template the
 * employees use to compile orders). Headers mix English and Dutch:
 *
 *   EAN, Description, Brand, SKU, tag,
 *   aankoopprijs, verkoopprijs, leverancier, btw,
 *   gewenste voorraad, herbestellingspunt
 *
 * `Description` holds the title, `Brand` holds the author (rokko convention).
 * Prices and stock fields are kept verbatim for audit but are not pushed to
 * C-Series by default — see `mapping.config.json`.
 */
export interface CbIntakeRow {
  ean: string;
  description?: string;
  /** Author name — column is labelled "Brand" in the template. */
  brand?: string;
  sku?: string;
  /** Free-form tag (e.g. "nederlands"). */
  tag?: string;
  /** Purchase price as a decimal string, e.g. "19.2". */
  purchasePrice?: string;
  /** Sell price as a decimal string, e.g. "30.00". */
  sellPrice?: string;
  /** Supplier name, e.g. "CB". */
  supplier?: string;
  /** Tax class, e.g. "Item". */
  taxClass?: string;
  /** Desired stock level (target). */
  desiredStock?: number;
  /** Reorder point. */
  reorderPoint?: number;
}

/**
 * Discriminated union carrying the raw upload row alongside its format kind.
 * The mapping engine uses `kind` to decide which dotted-path roots resolve.
 */
export type BookSource =
  | { kind: "r-series"; rSeries: RSeriesRow }
  | { kind: "cb-intake"; cb: CbIntakeRow };

export interface EnrichedBook {
  ean: string;
  /** Raw upload row + its format. */
  source: BookSource;

  // Enriched fields (merged across sources, see lib/enrichment/merge.ts)
  titleShort?: string;
  titleLong?: string;
  subtitle?: string;
  authors?: string[];
  publisher?: string;
  descriptionShort?: string;
  descriptionLong?: string; // may contain HTML
  weightGrams?: number;
  dimensionsMm?: BookDimensionsMm;
  pages?: number;
  language?: string;
  publicationDate?: string; // ISO yyyy[-mm[-dd]]
  categories?: string[];
  coverImageUrls?: string[];

  /** Provenance: which source supplied each enriched field. */
  fieldSources: Partial<Record<keyof EnrichedBook, EnrichmentSourceId>>;

  /** Per-source errors encountered during enrichment. Empty when all succeeded. */
  errors: Array<{ source: EnrichmentSourceId; message: string }>;
}
