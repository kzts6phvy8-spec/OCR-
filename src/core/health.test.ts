import { describe, expect, it } from "vitest";
import { emptyWarlordInput, normalizeInput } from "./domain.ts";
import { findIssues } from "./health.ts";
import type { OcrJob, Warlord, WarlordInput } from "./types.ts";

let n = 0;
const w = (input: Partial<WarlordInput>): Warlord => ({
  ...normalizeInput({ ...emptyWarlordInput(), name: "武将A", ...input }),
  id: `w${++n}`,
  screenshot_count: 0,
  created_at: "",
  updated_at: "",
});
const kinds = (ws: Warlord[], images: string[] = [], jobs: OcrJob[] = [], recent: string[] = []) =>
  findIssues(ws, new Set(images), jobs, new Set(recent)).map((i) => i.kind);

describe("自動点検", () => {
  it("同じ武将が分かれていそうなら知らせる (通常と特異・姫武将は別)", () => {
    expect(kinds([w({ faction: "東海" }), w({ faction: "東海" })])).toContain("duplicate");
    expect(kinds([w({}), w({ is_special: true })])).not.toContain("duplicate");
    expect(kinds([w({ faction: "東海" }), w({ faction: "姫武将" })])).not.toContain("duplicate");
    expect(kinds([w({ faction: "物語武将", rarity: "SSR" }), w({ faction: "物語武将", rarity: "SR" })])).not.toContain("duplicate");
  });

  it("連携スキルの重なり・鬼に混ざった連携・特異の姫武将は自動で直す", () => {
    const syn = { partner: "武将B", effect: "x" };
    const issues = findIssues(
      [
        w({ synergy_skills: [syn, { partner: "武将B", effect: "xx" }] }),
        w({ name: "鬼1", faction: "鬼憑武将", synergy_skills: [syn] }),
        w({ name: "姫1", faction: "姫武将", is_special: true }),
      ],
      new Set(),
      [],
    );
    expect(issues.filter((i) => i.autoFix).map((i) => i.kind).sort()).toEqual(["hime_special", "oni_synergy", "synergy_duplicate"]);
  });

  it("読み違いの疑いは知らせるだけ", () => {
    expect(kinds([w({ rarity: "SR", awakening_skill_name: "覚醒" })])).toContain("awakening_rarity");
    expect(kinds([w({ attack_growth: "+23" })])).toContain("odd_stat");
  });

  it("見つからない画像の記録・使われていない画像を見つける (保存したばかりの画像は消さない)", () => {
    const issues = findIssues([w({ gallery_images: ["a", "gone"], image_url: "a" })], new Set(["a", "orphan", "new"]), [], new Set(["new"]));
    expect(issues.find((i) => i.kind === "missing_image")?.imageIds).toEqual(["gone"]);
    expect(issues.find((i) => i.kind === "orphan_image")?.imageIds).toEqual(["orphan"]);
  });
});
