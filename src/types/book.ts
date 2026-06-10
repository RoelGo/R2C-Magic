/**
 * Canonical Book type — the lingua franca between R-series rows, online
 * enrichment sources, and the C-series writer.
 *
 * Every field is optional except `ean`, which is the join key across all
 * sources. R-series-only fields live on `rSeries`; enrichment-only fields
 * are unprefixed; provenance is tracked per field via `fieldSources`.
 */
export type EnrichmentSourceId = "google-books" | "open-library" | "kb-sru" | "cb" | "r-series";

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

export interface EnrichedBook {
  ean: string;
  rSeries: RSeriesRow;

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
