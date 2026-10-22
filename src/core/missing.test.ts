import { describe, expect, it } from "vitest";
import { emptyWarlordInput, normalizeInput } from "./domain.ts";
import { hasAnyMissing, missingLabels } from "./missing.ts";
import type { Warlord } from "./types.ts";

const warlord = (input: Parameters<typeof normalizeInput>[0]): Warlord => ({
  ...normalizeInput({ ...emptyWarlordInput(), name: "武将A", ...input }),
  id: "1",
  screenshot_count: 0,
  created_at: "",
  updated_at: "",
});

describe("未入力の項目", () => {
  it("空の項目を挙げる", () => {
    const w = warlord({
      rarity: "SSR",
      attack_base: 92,
      attack_growth: "+2.3",
      talents: [{ star_level: 1, position: "", name: "", effect: "物理防御+50%", unlocked: true }],
    });
    const labels = missingLabels(w);
    expect(labels).not.toContain("レア度");
    expect(labels).toContain("成長値の攻・防・計・兵");
    expect(labels).toContain("天賦");
    expect(labels).toContain("覚醒スキルの効果 (SSR・鬼・限定・コラボ)");
    // 武器覚醒が無い武将には、武器覚醒後の効果を求めない
    expect(labels).not.toContain("武器覚醒後の効果 (武器覚醒ありのみ)");
    expect(hasAnyMissing(w)).toBe(true);
  });
  it("覚醒スキルは SSR・鬼憑武将・限定武将だけに求める", () => {
    expect(missingLabels(warlord({ rarity: "SR", faction: "東海" }))).not.toContain("覚醒スキルの効果 (SSR・鬼・限定・コラボ)");
    expect(missingLabels(warlord({ rarity: "SR", faction: "東海" }))).not.toContain("覚醒スキルの優先度");
    expect(missingLabels(warlord({ rarity: "SR", faction: "鬼憑武将" }))).toContain("覚醒スキルの効果 (SSR・鬼・限定・コラボ)");
    expect(missingLabels(warlord({ rarity: "R", faction: "限定武将" }))).toContain("覚醒スキルの優先度");
  });
});
