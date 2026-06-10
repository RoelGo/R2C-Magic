# 03 — Mapping

The mapping between R-Series fields, enriched online metadata, and C-Series
columns is the heart of the product. It is **data, not code**: rules live in
`mapping.config.json` at the repo root, are validated against
`src/lib/csv/mapping-schema.ts`, and consumed by `src/lib/csv/{mapping,c-series,computed}.ts`.

This document explains the schema, the current rokko-approved mapping, and
how to extend it.

## Input shapes

### R-Series export (`imports/item_listings_local_matches.csv`)

- **Delimiter**: comma
- **Quoting**: every field quoted with `"`
- **Line ending**: LF
- **Columns** (28): `System ID, UPC, EAN, Custom SKU, Manufact. SKU, Item,
  Vendor ID, Qty., Price, Tax, Brand, Publish to eCom, Season, Department,
  MSRP, Tax Class, Default Cost, Vendor, Category, Subcategory 1..9`
- `EAN` is the join key for enrichment. We require a valid 13-digit ISBN-13.

### C-Series import (`templates/import-products.csv`)

- **Delimiter**: semicolon
- **Quoting**: only when needed (delimiter, quote, or newline in value)
- **Line ending**: CRLF
- **Columns** (43): see the full table below.

## Mapping config format

`mapping.config.json` has this top-level shape:

```jsonc
{
  "outputDelimiter": ";",
  "outputLineEnding": "CRLF",
  "outputBom": false,
  "imageSeparator": "|",
  "includeErrorColumn": true,
  "errorColumnName": "_enrichment_errors",

  "sourcePriority": ["cb", "kb-sru", "google-books", "open-library"],
  "fieldPriority": {
    "descriptionLong": ["cb", "google-books", "kb-sru", "open-library"],
    "coverImageUrls": "merge"
  },

  "columns": [
    { "name": "Visible", "type": "constant", "value": "Y" },
    { "name": "Brand",   "type": "field",    "from": ["enriched.publisher", "rseries.brand"] },
    { "name": "Tax",     "type": "ignore" },
    ...
  ]
}
```

### Column types

Each entry in `columns` is exactly one of:

| Type | Shape | Behavior |
|---|---|---|
| `constant` | `{ "type": "constant", "value": "Y" }` | Always emit the literal string |
| `ignore`   | `{ "type": "ignore" }` | Header is written, value is always blank |
| `field`    | `{ "type": "field", "from": "<path>" }` or `{ "from": [paths...] }` | Resolve the dotted path against the EnrichedBook. With a list, first non-empty wins. |
| `computed` | `{ "type": "computed", "expression": "<name>" }` | Run the named function in `src/lib/csv/computed.ts` |

### `from` paths

- `rseries.<lowerCamelField>` — reads `RSeriesRow.<field>`, e.g.
  `rseries.brand`, `rseries.category`, `rseries.item`.
- `rseries.subcategory.<n>` — reads `RSeriesRow.subcategories[n]` (0-indexed).
- `enriched.<field>` — reads the top-level `EnrichedBook` field, e.g.
  `enriched.titleLong`, `enriched.descriptionShort`, `enriched.publisher`.

### `transform` (optional, only on `field` columns)

```jsonc
{
  "type": "field",
  "from": "enriched.descriptionShort",
  "transform": { "stripHtml": true, "truncate": 200 }
}
```

| Key | Type | Effect |
|---|---|---|
| `stripHtml` | boolean | Replace tags with spaces, collapse whitespace |
| `truncate` | int | Cap length; truncates on a word boundary near the cut and appends `…` |
| `divide` | number | Numeric divide (used for `weightGrams → kg`) |

To add a new transform, edit `src/lib/csv/mapping-schema.ts` (Zod schema)
and `src/lib/csv/mapping.ts::applyTransforms`. Then add a test.

### Computed columns

Registered in `src/lib/csv/computed.ts`. Current functions:

| Expression | Output |
|---|---|
| `metaTitle` | `"${titleShort} – ${primaryAuthor}"`, falls back to title only |
| `metaKeywords` | Dedup of `authors + publisher + categories`, comma-joined |
| `images` | `coverImageUrls.join(imageSeparator)` after HTML-stripping each URL |

To add a new computed expression: add the function, extend the `enum` in
`mapping-schema.ts::columnSchema.expression`, and add a test.

### `sourcePriority`

The global default order for resolving merged fields. Per-field overrides
go in `fieldPriority`.

Current value: `["cb", "kb-sru", "google-books", "open-library"]`.

Rationale: CB has the richest Dutch trade data when available; KB SRU has
strong Dutch coverage with no auth; Google Books is broad; Open Library is
the most permissive fallback. `r-series` can appear in a per-field priority
list (it means "use the R-series value as fallback").

### `fieldPriority`

Per-field source order. A value of `"merge"` means "union across all sources
in `sourcePriority`, dedup preserving first-seen". Currently used only for
`coverImageUrls`.

### Error column

When `includeErrorColumn` is true, an extra column (default name
`_enrichment_errors`) is appended to the output. For each row it contains
`source: message; source: message` for every source that errored on that
EAN. This is **not** in the C-Series template — it's a R2C Magic addition
so rokko can spot and patch gaps after import.

## Current rokko-approved mapping (43 columns)

Legend: ✏️ = actively mapped, 🗑️ = `ignore` (written blank).

| # | C-Series column | Source | Default | Notes |
|---|---|---|---|---|
| 1  | `Visible`                | ✏️ constant `Y` | — | New items visible immediately |
| 2  | `Brand`                  | ✏️ `enriched.publisher` ∥ `rseries.brand` | blank | For books, "Brand" = uitgever |
| 3  | `Supplier`               | 🗑️ ignore | blank | Handled by C-side merge |
| 4  | `NL_Title_Short`         | ✏️ `rseries.item` (truncated 80) | required | |
| 5  | `NL_Title_Long`          | ✏️ `enriched.titleLong` ∥ `rseries.item` | rseries.item | |
| 6  | `NL_Description_Short`   | ✏️ `enriched.descriptionShort` (stripHtml, 200) | blank | |
| 7  | `NL_Description_Long`    | ✏️ `enriched.descriptionLong` (HTML allowed) | blank | |
| 8  | `NL_Variant`             | ✏️ constant `Default` | — | |
| 9  | `Price`                  | 🗑️ ignore | blank | Handled by C-side merge |
| 10 | `Price_Old`              | 🗑️ ignore | blank | |
| 11 | `Price_Cost`             | 🗑️ ignore | blank | |
| 12 | `Price_Unit`             | 🗑️ ignore | blank | |
| 13 | `Unit`                   | 🗑️ ignore | blank | |
| 14 | `Tax`                    | 🗑️ ignore | blank | Handled by C-side merge |
| 15 | `Stock_Track`            | ✏️ constant `Y` | — | |
| 16 | `Stock_Disable_Sold_Out` | ✏️ constant `N` | — | |
| 17 | `Stock_Level`            | 🗑️ ignore | blank | Handled by C-side merge |
| 18 | `Stock_Min`              | ✏️ constant `0` | — | |
| 19 | `Stock_Alert`            | 🗑️ ignore | blank | |
| 20 | `Article_Code`           | 🗑️ ignore | blank | |
| 21 | `EAN`                    | ✏️ `rseries.ean` | required | Lookup key |
| 22 | `SKU`                    | 🗑️ ignore | blank | |
| 23 | `Weight`                 | ✏️ `enriched.weightGrams` (÷1000) | blank | kg |
| 24 | `Volume`                 | 🗑️ ignore | blank | |
| 25 | `Colli`                  | 🗑️ ignore | blank | |
| 26 | `Size_X`                 | 🗑️ ignore | blank | |
| 27 | `Size_Y`                 | 🗑️ ignore | blank | |
| 28 | `Size_Z`                 | 🗑️ ignore | blank | |
| 29 | `Matrix`                 | ✏️ constant `` | — | |
| 30 | `Data_01`                | ✏️ constant `` | — | Reserved for future use |
| 31 | `Data_02`                | ✏️ constant `` | — | Reserved for future use |
| 32 | `Data_03`                | ✏️ constant `` | — | Reserved for future use |
| 33 | `Buy_Min`                | 🗑️ ignore | blank | |
| 34 | `Buy_Max`                | 🗑️ ignore | blank | |
| 35 | `NL_Google_Category`     | ✏️ constant `Media > Books` | — | See open question on per-category mapping |
| 36 | `NL_Category_1`          | ✏️ `rseries.category` | blank | |
| 37 | `NL_Category_2`          | ✏️ `rseries.subcategory.0` | blank | |
| 38 | `NL_Category_3`          | ✏️ `rseries.subcategory.1` | blank | |
| 39 | `NL_Meta_Title`          | ✏️ computed `metaTitle` | titleShort | |
| 40 | `NL_Meta_Description`    | ✏️ `enriched.descriptionShort` (stripHtml, 160) | blank | |
| 41 | `NL_Meta_Keywords`       | ✏️ computed `metaKeywords` | blank | |
| 42 | `Images`                 | ✏️ computed `images` | blank | Joined with `\|` |
| 43 | `Tags`                   | 🗑️ ignore | blank | |
| +1 | `_enrichment_errors`     | error column (appended) | blank | Not in template |

**Counts**: 19 ignored, 24 actively mapped, plus the error column.

## Editing the mapping

1. Edit `mapping.config.json` directly.
2. Restart the app (or `docker compose restart app`) — the config is cached
   on first load.
3. Run `pnpm test` — `tests/csv/mapping-config.test.ts` validates the file
   and asserts the ignore list matches the negotiated set.

An in-app editor is on the roadmap as M3.

## Changing the ignore list

The set of ignored columns was negotiated with rokko (decision #14 in
`spec/01-overview.md`). Per AGENTS.md hard rule 8: do **not** change this
list without an explicit ask. If you must, update the assertion in
`tests/csv/mapping-config.test.ts` in the same change so the test reflects
the new agreement.
