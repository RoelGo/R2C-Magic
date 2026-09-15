import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  describeFromLayout,
  joinRegions,
  layoutLines,
  selectDescriptionRegion,
  toBackCoverRegions,
} from "../../src/lib/ocr/description";
import type { LayoutRegion, LayoutResult } from "../../src/lib/ocr/layout";

/**
 * Region-selection heuristic for the back-cover blurb (spec v2 US-D7).
 *
 * Exercised against the committed layout snapshots produced by the (opt-in)
 * PaddleOCR integration test, so the heuristic is pinned to real covers without
 * running a model.
 */
interface SnapshotRegion {
  label: string;
  score: number;
  box: [number, number, number, number];
  text: string;
}
interface Snapshot {
  imageWidth: number;
  imageHeight: number;
  regions: SnapshotRegion[];
  unassignedLines: string[];
}

/** Load a snapshot and shape it as a `LayoutResult` (line boxes are dropped in
 * the snapshot, so each region gets a single synthetic line carrying its text). */
function loadSnapshot(name: string): LayoutResult {
  const path = join(import.meta.dirname, "..", "integration", `layout-${name}.json`);
  const snap = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
  return {
    imageWidth: snap.imageWidth,
    imageHeight: snap.imageHeight,
    regions: snap.regions.map(({ label, score, box, text }) => ({
      label,
      score,
      box: { x: box[0], y: box[1], width: box[2], height: box[3] },
      lines: text ? [{ text, box: { x: box[0], y: box[1], width: box[2], height: box[3] } }] : [],
      text,
    })),
    unassignedLines: snap.unassignedLines.map((text, i) => ({
      text,
      box: { x: 0, y: 10_000 + i, width: 1, height: 1 },
    })),
  };
}

function region(partial: Partial<LayoutRegion> & { text: string }): LayoutRegion {
  return {
    label: "text",
    score: 0.9,
    box: { x: 0, y: 0, width: 1000, height: 500 },
    lines: [],
    ...partial,
  };
}

const BLURB = "Een jongeman biedt zich aan om huiswerkbegeleider te worden ".repeat(3);

describe("lib/ocr/description — selectDescriptionRegion", () => {
  it("picks the wide blurb over narrow press quotes (back-with-blurbs)", () => {
    const description = describeFromLayout(loadSnapshot("back-with-blurbs"));
    expect(description).toMatch(/^Een jongeman biedt zich aan/);
    expect(description).not.toMatch(/Anna Drijver|Hulde|BORGERHOFF/);
  });

  it("picks the blurb opener, not the author bio below it (back-with-a-lot-of-text)", () => {
    const picked = selectDescriptionRegion(loadSnapshot("back-with-a-lot-of-text"));
    expect(picked?.label).toBe("text");
    expect(picked?.text).toMatch(/^Even bad code can function/);
    expect(picked?.text).not.toMatch(/ISBN|Pearson|Uncle Bob|Software Engineering\/Programming/);
  });

  it("picks the blurb over the bio and publisher URL (cover)", () => {
    const picked = selectDescriptionRegion(loadSnapshot("cover"));
    expect(picked?.text).toMatch(/^Utilitarianism is/);
    expect(picked?.text).not.toMatch(/www\.oup|assistant professor/);
  });

  it("prefers the topmost of the full-width regions (blurb before bio)", () => {
    const blurb = region({
      text: `Blurb ${BLURB}`,
      box: { x: 0, y: 100, width: 900, height: 400 },
    });
    const bio = region({ text: `Bio ${BLURB}`, box: { x: 0, y: 600, width: 1000, height: 400 } });
    const picked = selectDescriptionRegion({
      imageWidth: 1000,
      imageHeight: 1000,
      regions: [blurb, bio],
      unassignedLines: [],
    });
    expect(picked?.text).toBe(blurb.text);
  });

  it("prefers a wide column over a narrow press-quote column", () => {
    const narrow = region({
      text: `narrow ${BLURB}`,
      box: { x: 0, y: 0, width: 400, height: 900 },
    });
    const wide = region({ text: `wide ${BLURB}`, box: { x: 0, y: 0, width: 900, height: 300 } });
    const picked = selectDescriptionRegion({
      imageWidth: 1000,
      imageHeight: 1000,
      regions: [narrow, wide],
      unassignedLines: [],
    });
    expect(picked?.text).toBe(wide.text);
  });

  it("returns undefined when nothing qualifies (so the caller falls back)", () => {
    const result: LayoutResult = {
      imageWidth: 1000,
      imageHeight: 1000,
      regions: [
        region({ text: "ISBN 978-0-19-872879-5 and more filler text ".repeat(4) }),
        region({ label: "footer", text: BLURB }),
        region({ text: "Too short." }),
      ],
      unassignedLines: [],
    };
    expect(selectDescriptionRegion(result)).toBeUndefined();
    expect(describeFromLayout(result)).toBeUndefined();
  });

  it("returns undefined for an empty layout result", () => {
    expect(
      selectDescriptionRegion({
        imageWidth: 0,
        imageHeight: 0,
        regions: [],
        unassignedLines: [],
      }),
    ).toBeUndefined();
  });
});

describe("lib/ocr/description — layoutLines", () => {
  it("returns every recognised line in top-to-bottom reading order", () => {
    const lines = layoutLines({
      imageWidth: 100,
      imageHeight: 100,
      regions: [
        region({
          text: "second",
          lines: [{ text: "second", box: { x: 0, y: 50, width: 10, height: 10 } }],
        }),
        region({
          text: "first",
          lines: [{ text: "first", box: { x: 0, y: 10, width: 10, height: 10 } }],
        }),
      ],
      unassignedLines: [{ text: "third", box: { x: 0, y: 90, width: 10, height: 10 } }],
    });
    expect(lines).toEqual(["first", "second", "third"]);
  });
});

describe("lib/ocr/description — toBackCoverRegions / joinRegions (US-D8)", () => {
  it("exposes every text-carrying region and flags the auto-picked one", () => {
    const regions = toBackCoverRegions(loadSnapshot("back-with-blurbs"));
    expect(regions?.imageWidth).toBe(3024);
    expect(regions?.regions).toHaveLength(7);
    const auto = regions?.regions.filter((r) => r.autoSelected) ?? [];
    expect(auto).toHaveLength(1);
    expect(auto[0]?.text).toMatch(/^Een jongeman biedt zich aan/);
  });

  it("drops regions with no recognised text", () => {
    const regions = toBackCoverRegions(loadSnapshot("back-with-a-lot-of-text"));
    // The snapshot's `doc_title` region has no lines assigned to it.
    expect(regions?.regions.every((r) => r.text.length > 0)).toBe(true);
  });

  it("returns undefined when there is nothing to show", () => {
    expect(
      toBackCoverRegions({ imageWidth: 100, imageHeight: 100, regions: [], unassignedLines: [] }),
    ).toBeUndefined();
  });

  it("joins the selected regions in top-to-bottom reading order", () => {
    const regions = [
      {
        id: "r0",
        label: "text",
        box: { x: 0, y: 200, width: 10, height: 10 },
        text: "Second.",
        autoSelected: false,
      },
      {
        id: "r1",
        label: "text",
        box: { x: 0, y: 10, width: 10, height: 10 },
        text: "First.",
        autoSelected: true,
      },
      {
        id: "r2",
        label: "text",
        box: { x: 0, y: 400, width: 10, height: 10 },
        text: "Skipped.",
        autoSelected: false,
      },
    ];
    expect(joinRegions(regions, ["r0", "r1"])).toBe("First.\n\nSecond.");
  });

  it("ignores unknown ids from a stale selection", () => {
    expect(joinRegions([], ["r9"])).toBe("");
  });
});
