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
    expect(labels).not.toContain("攻");
    expect(labels).toContain("防");
    expect(labels).toContain("天賦 (星1〜5 のどれか)");
    // 武器覚醒が無い武将には、武器覚醒後の効果を求めない
    expect(labels).not.toContain("武器覚醒後の効果 (武器覚醒ありの武将)");
    expect(hasAnyMissing(w)).toBe(true);
  });
});
