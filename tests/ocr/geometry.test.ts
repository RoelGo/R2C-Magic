import { describe, expect, it } from "vitest";
import { boxFromVertices } from "../../src/lib/ocr/geometry";

describe("lib/ocr/geometry — boxFromVertices", () => {
  it("reduces a rectangle polygon to its bounding box", () => {
    expect(
      boxFromVertices([
        [10, 20],
        [110, 20],
        [110, 60],
        [10, 60],
      ]),
    ).toEqual({ x: 10, y: 20, width: 100, height: 40 });
  });

  it("handles a skewed quad by taking min/max extents", () => {
    expect(
      boxFromVertices([
        [12, 22],
        [108, 18],
        [110, 58],
        [8, 62],
      ]),
    ).toEqual({ x: 8, y: 18, width: 102, height: 44 });
  });

  it("returns undefined for an empty vertex list", () => {
    expect(boxFromVertices([])).toBeUndefined();
  });
});
