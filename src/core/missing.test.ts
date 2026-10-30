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
    expect(labels).toContain("成長値の合計");
    expect(labels).toContain("成長値の攻・防・計・兵");
    expect(labels).toContain("天賦");
    expect(labels).toContain("覚醒スキルの効果 (SSR のみ)");
    // 武器覚醒が無い武将には、武器覚醒後の効果を求めない
    expect(labels).not.toContain("武器覚醒後の効果 (武器覚醒ありのみ)");
    expect(hasAnyMissing(w)).toBe(true);
  });
  it("覚醒スキルは SR・R・N には求めない", () => {
    const effect = "覚醒スキルの効果 (SSR のみ)";
    expect(missingLabels(warlord({ rarity: "SSR", faction: "東海" }))).toContain(effect);
    expect(missingLabels(warlord({ rarity: "SSR", faction: "東海" }))).toContain("覚醒スキルの優先度");
    for (const rarity of ["SR", "R", "N"] as const) {
      for (const faction of ["東海", "鬼憑武将", "限定武将", "コラボ武将"] as const) {
        const labels = missingLabels(warlord({ rarity, faction, has_awakening: true }));
        expect(labels).not.toContain(effect);
        expect(labels).not.toContain("覚醒スキルの優先度");
      }
    }
    // レア度が未入力なら、鬼憑武将・限定武将・コラボ武将は覚醒スキルを持つとみなす
    expect(missingLabels(warlord({ faction: "鬼憑武将" }))).toContain(effect);
    expect(missingLabels(warlord({ faction: "東海" }))).not.toContain(effect);
  });
});
