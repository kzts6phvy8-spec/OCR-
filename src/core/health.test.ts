import { describe, expect, it } from "vitest";
import { emptyWarlordInput, normalizeInput } from "./domain.ts";
import { findIssues } from "./health.ts";
import type { Warlord, WarlordInput } from "./types.ts";

let n = 0;
const w = (input: Partial<WarlordInput>): Warlord => ({
  ...normalizeInput({ ...emptyWarlordInput(), name: "武将A", ...input }),
  id: `w${++n}`,
  screenshot_count: 0,
  created_at: "",
  updated_at: "",
});
const ids = (k: number) => Array.from({ length: k }, (_, i) => `i${i}`);
const kinds = (ws: Warlord[]) => findIssues(ws).map((i) => i.kind);

describe("自動点検", () => {
  it("画像が 7 枚以上と、1 枚だけの武将だけを知らせる", () => {
    expect(kinds([w({ gallery_images: ids(7) })])).toEqual(["too_many_images"]);
    expect(kinds([w({ gallery_images: ids(1) })])).toEqual(["single_image"]);
    for (const k of [0, 2, 6]) expect(kinds([w({ gallery_images: ids(k) })])).toEqual([]);
    // ほかのことは知らせない (同じ名前の武将・読み違いの疑いなど)
    expect(kinds([w({ gallery_images: ids(3), rarity: "SR", awakening_skill_name: "x" }), w({ gallery_images: ids(3) })])).toEqual([]);
  });
});
