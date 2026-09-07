/**
 * Geometry helpers for OCR line boxes (spec v2 US-D5).
 *
 * Engines expose recognised lines as polygons (four `[x, y]` vertices, possibly
 * skewed). Extraction only needs an axis-aligned bounding box, so we reduce a
 * polygon to its min/max extents. Kept pure and I/O-free for unit testing.
 */
import type { OcrBox } from "./engine";

export type Vertex = readonly [number, number];

/**
 * Reduce a polygon (any number of vertices ≥ 1) to its axis-aligned bounding
 * box. Returns `undefined` for an empty vertex list so callers can omit the box
 * rather than emit a degenerate zero-size one.
 */
export function boxFromVertices(vertices: readonly Vertex[]): OcrBox | undefined {
  if (vertices.length === 0) return undefined;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const [x, y] of vertices) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
