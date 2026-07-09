import { z } from "zod";

/**
 * Zod schema for `mapping.config.json`. Validated on load so a malformed
 * mapping fails at startup rather than during a run.
 */

const transformSchema = z
  .object({
    truncate: z.number().int().positive().optional(),
    stripHtml: z.boolean().optional(),
    divide: z.number().positive().optional(),
  })
  .strict();

const columnSchema = z.discriminatedUnion("type", [
  z.object({
    name: z.string().min(1),
    type: z.literal("constant"),
    value: z.string(),
  }),
  z.object({
    name: z.string().min(1),
    type: z.literal("ignore"),
  }),
  z.object({
    name: z.string().min(1),
    type: z.literal("field"),
    /** Single path or ordered fallback list. First non-empty wins. */
    from: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    transform: transformSchema.optional(),
    /**
     * Value used when every path in `from` resolves to empty/undefined
     * (i.e. enrichment found nothing). The default is emitted verbatim and
     * is not passed through `transform`.
     */
    default: z.string().optional(),
  }),
  z.object({
    name: z.string().min(1),
    type: z.literal("computed"),
    /** Name of a function in src/lib/csv/computed.ts */
    expression: z.enum(["metaTitle", "metaKeywords", "images"]),
    /**
     * Value used when the computed expression yields an empty string, e.g. a
     * standard cover URL for `images` when enrichment found no cover.
     */
    default: z.string().optional(),
  }),
]);

export type MappingColumn = z.infer<typeof columnSchema>;

const sourceId = z.enum(["cb", "google-books", "open-library", "r-series"]);

export const mappingConfigSchema = z
  .object({
    $schema: z.string().optional(),
    outputDelimiter: z.string().length(1).default(";"),
    outputLineEnding: z.enum(["LF", "CRLF"]).default("CRLF"),
    outputBom: z.boolean().default(false),
    imageSeparator: z.string().min(1).default("|"),
    includeErrorColumn: z.boolean().default(true),
    errorColumnName: z.string().min(1).default("_enrichment_errors"),
    sourcePriority: z.array(sourceId).default(["cb", "google-books", "open-library"]),
    fieldPriority: z
      .record(z.string(), z.union([z.array(sourceId), z.literal("merge")]))
      .default({}),
    columns: z.array(columnSchema).min(1),
  })
  .strict();

export type MappingConfig = z.infer<typeof mappingConfigSchema>;
