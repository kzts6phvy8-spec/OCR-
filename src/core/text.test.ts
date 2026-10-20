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
  it("項目がある部分だけを書き出す", () => {
    const text = warlordToText(
      w({
        name: "武将A",
        rarity: "SSR",
        faction: "東海",
        level: 1,
        stars: 1,
        growth_total: "9",
        attack_base: 92,
        attack_growth: "+2.3",
        skill_name: "スキルA",
        skill_gauge: 1,
        skill_desc: "効果A",
        has_awakening: true,
        awakening_skill_name: "覚醒A",
        awakening_priority: "低",
        awakening_before_weapon: "覚醒効果",
      }),
    );
    expect(text).toBe(
      [
        "【SSR】武将A",
        "勢力: 東海 / Lv.1 / ★1",
        "",
        "成長値: 9",
        "攻 92 (+2.3)",
        "",
        "■ 奥義スキル (奥義ゲージ1): スキルA",
        "効果A",
        "",
        "■ 覚醒スキル (低): 覚醒A",
        "覚醒効果",
      ].join("\n"),
    );
  });
  it("特異と武器覚醒を明記する", () => {
    const text = warlordToText(
      w({ name: "武将A", is_special: true, has_awakening: true, has_weapon_awakening: true, awakening_skill_name: "覚醒A", awakening_before_weapon: "前", awakening_after_weapon: "後" }),
    );
    expect(text).toContain("武将A (特異)");
    expect(text).toContain("[武器覚醒前] 前");
    expect(text).toContain("[武器覚醒後] 後");
  });
});
