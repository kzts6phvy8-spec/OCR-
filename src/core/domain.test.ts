import { describe, expect, it } from "vitest";
import {
  decideSpecial,
  emptyWarlordInput,
  extractionToPatch,
  mergeWarlord,
  normalizeFaction,
  normalizeName,
  normalizePriority,
  splitAwakeningName,
} from "./domain.ts";
import { makeExtraction } from "./testUtils.ts";

describe("normalizeName", () => {
  it("接頭辞と【特】表記を除去する", () => {
    expect(normalizeName("【SSR】武将A")).toEqual({ name: "武将A", hasSpecialMarker: false });
    expect(normalizeName("【特】武将A")).toEqual({ name: "武将A", hasSpecialMarker: true });
  });
});

describe("decideSpecial", () => {
  it("画面の【特】表記で特異と判定", () => {
    const ext = makeExtraction({ name: "武将A", special_marker_visible: true });
    expect(decideSpecial(ext, "auto").is_special).toBe(true);
  });
  it("表記が無ければ通常", () => {
    expect(decideSpecial(makeExtraction({ name: "武将A" }), "auto").is_special).toBe(false);
  });
  it("手動指定が最優先", () => {
    const ext = makeExtraction({ name: "武将A", special_marker_visible: true });
    const d = decideSpecial(ext, "force_normal");
    expect(d.is_special).toBe(false);
    expect(d.warnings.length).toBe(1);
    expect(decideSpecial(makeExtraction({ name: "武将A" }), "force_special").is_special).toBe(true);
  });
});

describe("extractionToPatch", () => {
  it("写っていない項目は patch に含めない", () => {
    const patch = extractionToPatch(makeExtraction({ name: "武将A", level: 80 }));
    expect(patch).toEqual({ level: 80 });
  });
  it("覚醒名から優先度を分離し、武器覚醒は写っている時だけ採用", () => {
    const patch = extractionToPatch(
      makeExtraction({
        awakening: {
          visible: true,
          skill_name: "覚醒A(極高)",
          before_weapon_effect: "前",
          weapon_awakening_visible: false,
          after_weapon_effect: "AIが補った後効果",
        },
      }),
    );
    expect(patch.awakening_skill_name).toBe("覚醒A");
    expect(patch.awakening_priority).toBe("極高");
    expect(patch.has_weapon_awakening).toBeUndefined();
    expect(patch.awakening_after_weapon).toBeUndefined();
  });
  it("発動優先度を「甲・1」の形にそろえる", () => {
    expect(normalizePriority("丁·4")).toBe("丁・4");
    expect(normalizePriority("（癸・10）")).toBe("癸・10");
    expect(normalizePriority("壬9")).toBe("壬・9");
    expect(normalizePriority("乙")).toBe("乙・2");
    expect(normalizePriority("3")).toBe("丙・3");
    expect(normalizePriority("低")).toBe("低");
    expect(normalizePriority("11")).toBe("");
    expect(normalizePriority("不明")).toBe("");
    expect(splitAwakeningName("覚醒B（戊·5）")).toEqual({ name: "覚醒B", priority: "戊・5" });
    expect(splitAwakeningName("覚醒C(特別)")).toEqual({ name: "覚醒C(特別)", priority: "" });
    const old = { ...emptyWarlordInput(), name: "武将A", awakening_priority: "低" };
    const { merged, warnings } = mergeWarlord(old, { awakening_priority: "丁・4" });
    expect(merged.awakening_priority).toBe("丁・4");
    expect(warnings).toEqual([]);
  });
  it("成長率に符号を付ける", () => {
    const patch = extractionToPatch(makeExtraction({ attack: { base: 120, growth: "2.6" } }));
    expect(patch.attack_growth).toBe("+2.6");
    expect(patch.attack_base).toBe(120);
  });
});

describe("mergeWarlord", () => {
  const base = { ...emptyWarlordInput(), name: "武将A", skill_name: "スキルA", level: 60, gallery_images: ["/a.png"], image_url: "/a.png" };

  it("空欄を埋め、既存値は保持して警告", () => {
    const { merged, warnings } = mergeWarlord(base, { skill_name: "誤読", title_alias: "二つ名A", gallery_images: ["/b.png"] });
    expect(merged.skill_name).toBe("スキルA");
    expect(merged.title_alias).toBe("二つ名A");
    expect(merged.gallery_images).toEqual(["/a.png", "/b.png"]);
    expect(merged.image_url).toBe("/a.png");
    expect(warnings).toHaveLength(1);
  });
  it("Lv は大きい方、天賦は星ごとに統合", () => {
    const first = mergeWarlord(base, {
      level: 50,
      talents: [{ star_level: 1, position: "", name: "天賦A", effect: "攻+5", unlocked: true }],
    }).merged;
    expect(first.level).toBe(60);
    const second = mergeWarlord(first, {
      talents: [
        { star_level: 1, position: "上", name: "天賦A", effect: "攻+5%（部隊）", unlocked: false },
        { star_level: 2, position: "", name: "天賦B", effect: "防+5", unlocked: false },
      ],
    }).merged;
    expect(second.talents).toEqual([
      { star_level: 1, position: "上", name: "天賦A", effect: "攻+5%（部隊）", unlocked: true },
      { star_level: 2, position: "", name: "天賦B", effect: "防+5", unlocked: false },
    ]);
  });
  it("連携スキルを相方ごとに統合", () => {
    const first = mergeWarlord(base, { synergy_skills: [{ partner: "武将B", effect: "短" }] }).merged;
    const second = mergeWarlord(first, {
      synergy_skills: [
        { partner: "武将B", effect: "より長い効果" },
        { partner: "武将C", effect: "x" },
      ],
    }).merged;
    expect(second.synergy_skills.map((s) => s.partner)).toEqual(["武将B", "武将C"]);
    expect(second.synergy_skills[0].effect).toBe("より長い効果");
  });
});

describe("misc normalizers", () => {
  it("勢力の表記揺れ", () => {
    expect(normalizeFaction("奥関甲")).toBe("奥.関.甲");
    expect(normalizeFaction("中・九")).toBe("中.九");
    expect(normalizeFaction("東海")).toBe("東海");
    expect(normalizeFaction("謎")).toBe("");
  });
  it("覚醒名の優先度分離", () => {
    expect(splitAwakeningName("覚醒A（高）")).toEqual({ name: "覚醒A", priority: "高" });
  });
});
