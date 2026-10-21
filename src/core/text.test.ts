import { describe, expect, it } from "vitest";
import { emptyWarlordInput } from "./domain.ts";
import { warlordToText } from "./text.ts";
import type { Warlord } from "./types.ts";

const w = (over: Partial<Warlord>): Warlord => ({
  ...emptyWarlordInput(),
  id: "1",
  screenshot_count: 0,
  created_at: "",
  updated_at: "",
  ...over,
});

describe("warlordToText", () => {
  it("利用者の書式どおりに書き出す", () => {
    const text = warlordToText(
      w({
        name: "武将A",
        rarity: "SSR",
        growth_total: "9",
        attack_base: 92,
        attack_growth: "+2.3",
        stratagem_base: 96,
        stratagem_growth: "+2.5",
        defense_base: 31,
        defense_growth: "+1.2",
        troops_base: 97,
        troops_growth: "+3",
        skill_gauge: 1,
        skill_desc: "効果A",
        has_awakening: true,
        awakening_priority: "低",
        awakening_before_weapon: "覚醒効果",
        talents: [
          { star_level: 1, position: "", name: "", effect: "物理防御+50%", unlocked: true },
          { star_level: 2, position: "", name: "", effect: "受け止め+25%", unlocked: true },
        ],
        troop_variants: ["兵種A", "兵種B"],
        synergy_skills: [{ partner: "武将B", effect: "武将B、武将Aが同時に場内にいる場合、計略防御+20%" }],
      }),
    );
    expect(text).toBe(
      [
        "武将名:武将A",
        "奥義スキル（奥義ゲージ1）: 効果A",
        "覚醒スキル（低）: 覚醒効果",
        "天賦:星1物理防御+50%",
        "星2受け止め+25%",
        "兵種:兵種A、兵種B",
        "レア度:SSR",
        "連携スキル",
        "武将B、武将Aが同時に場内にいる場合、計略防御+20%",
        "成長値：9",
        "攻：92 （+2.3）計：96 （+2.5）",
        "防：31 （+1.2） 兵：97 （+3）",
      ].join("\n"),
    );
  });
  it("スキル名・特異・武器覚醒を書き出す", () => {
    const text = warlordToText(
      w({
        name: "武将A",
        is_special: true,
        skill_name: "スキルA",
        skill_desc: "効果",
        has_awakening: true,
        has_weapon_awakening: true,
        awakening_skill_name: "覚醒A",
        awakening_before_weapon: "前",
        awakening_after_weapon: "後",
      }),
    );
    expect(text).toContain("武将名:武将A (特異)");
    expect(text).toContain("奥義スキル: 『スキルA』効果");
    expect(text).toContain("覚醒スキル: 『覚醒A』前");
    expect(text).toContain("武器覚醒後: 後");
  });
});
