import { describe, expect, it } from "vitest";
import {
  decideSpecial,
  emptyWarlordInput,
  extractionToPatch,
  mergeWarlord,
  normalizeFaction,
  normalizeName,
  sanitizeWeaponAwakening,
  splitAwakeningName,
} from "./domain.ts";
import { makeExtraction } from "./testUtils.ts";

describe("normalizeName", () => {
  it("接頭辞と特異表記を除去する", () => {
    expect(normalizeName("【SSR】前田慶次")).toEqual({ name: "前田慶次", hasSpecialMarker: false });
    expect(normalizeName("特異 百地三太夫")).toEqual({ name: "百地三太夫", hasSpecialMarker: true });
    expect(normalizeName("【特】井伊直虎")).toEqual({ name: "井伊直虎", hasSpecialMarker: true });
    expect(normalizeName("井伊直虎（特）")).toEqual({ name: "井伊直虎", hasSpecialMarker: true });
  });
});

describe("decideSpecial", () => {
  it("【特】アイコンで特異と判定", () => {
    const ext = makeExtraction({ name: "前田慶次", special_evidence: { special_icon_next_to_rating: true } });
    expect(decideSpecial(ext, "auto").is_special).toBe(true);
  });
  it("特異固有スキルで特異と判定", () => {
    const ext = makeExtraction({ name: "前田慶次", skill: { name: "人生如夢" } });
    expect(decideSpecial(ext, "auto").is_special).toBe(true);
  });
  it("根拠が無ければ通常", () => {
    expect(decideSpecial(makeExtraction({ name: "前田慶次" }), "auto").is_special).toBe(false);
  });
  it("手動指定が最優先", () => {
    const ext = makeExtraction({ name: "前田慶次", skill: { name: "人生如夢" } });
    const d = decideSpecial(ext, "force_normal");
    expect(d.is_special).toBe(false);
    expect(d.warnings.length).toBe(1);
    expect(decideSpecial(makeExtraction({ name: "x" }), "force_special").is_special).toBe(true);
  });
});

describe("extractionToPatch", () => {
  it("写っていない項目は patch に含めない", () => {
    const patch = extractionToPatch(makeExtraction({ name: "前田慶次", level: 80 }));
    expect(patch).toEqual({ level: 80 });
  });
  it("覚醒名から優先度を分離し、武器覚醒は写っている時だけ採用", () => {
    const patch = extractionToPatch(
      makeExtraction({
        awakening: {
          visible: true,
          skill_name: "焦熱獄(極高)",
          before_weapon_effect: "前",
          weapon_awakening_visible: false,
          after_weapon_effect: "AIが補った後効果",
        },
      }),
    );
    expect(patch.awakening_skill_name).toBe("焦熱獄");
    expect(patch.awakening_priority).toBe("極高");
    expect(patch.has_weapon_awakening).toBeUndefined();
    expect(patch.awakening_after_weapon).toBeUndefined();
  });
  it("成長率に符号を付ける", () => {
    const patch = extractionToPatch(makeExtraction({ attack: { base: 120, growth: "2.6" } }));
    expect(patch.attack_growth).toBe("+2.6");
    expect(patch.attack_base).toBe(120);
  });
});

describe("mergeWarlord", () => {
  const base = { ...emptyWarlordInput(), name: "前田慶次", skill_name: "傾奇者", level: 60, gallery_images: ["/a.png"], image_url: "/a.png" };

  it("空欄を埋め、既存値は保持して警告", () => {
    const { merged, warnings } = mergeWarlord(base, { skill_name: "誤読", title_alias: "傾奇御免", gallery_images: ["/b.png"] });
    expect(merged.skill_name).toBe("傾奇者");
    expect(merged.title_alias).toBe("傾奇御免");
    expect(merged.gallery_images).toEqual(["/a.png", "/b.png"]);
    expect(merged.image_url).toBe("/a.png");
    expect(warnings).toHaveLength(1);
  });
  it("Lv は大きい方、天賦は星ごとに統合", () => {
    const first = mergeWarlord(base, {
      level: 50,
      talents: [{ star_level: 1, position: "", name: "剛勇", effect: "攻+5", unlocked: true }],
    }).merged;
    expect(first.level).toBe(60);
    const second = mergeWarlord(first, {
      talents: [
        { star_level: 1, position: "上", name: "剛勇", effect: "攻+5%（部隊）", unlocked: false },
        { star_level: 2, position: "", name: "鉄壁", effect: "防+5", unlocked: false },
      ],
    }).merged;
    expect(second.talents).toEqual([
      { star_level: 1, position: "上", name: "剛勇", effect: "攻+5%（部隊）", unlocked: true },
      { star_level: 2, position: "", name: "鉄壁", effect: "防+5", unlocked: false },
    ]);
  });
  it("連携スキルを相方ごとに統合", () => {
    const first = mergeWarlord(base, { synergy_skills: [{ partner: "直江兼続", effect: "短" }] }).merged;
    const second = mergeWarlord(first, {
      synergy_skills: [
        { partner: "直江兼続", effect: "より長い効果" },
        { partner: "上杉景勝", effect: "x" },
      ],
    }).merged;
    expect(second.synergy_skills.map((s) => s.partner)).toEqual(["直江兼続", "上杉景勝"]);
    expect(second.synergy_skills[0].effect).toBe("より長い効果");
  });
});

describe("sanitizeWeaponAwakening", () => {
  const normal = {
    is_special: false,
    has_weapon_awakening: true,
    awakening_skill_name: "焦熱獄",
    awakening_before_weapon: "通常前",
    awakening_after_weapon: "焦熱獄+ の効果",
  };
  it("通常武将の武器覚醒が特異武将に混入したら除去", () => {
    const special = {
      ...emptyWarlordInput(),
      name: "百地三太夫",
      is_special: true,
      has_awakening: true,
      awakening_skill_name: "浄三業",
      has_weapon_awakening: true,
      awakening_after_weapon: "焦熱獄+ の効果",
    };
    const { record, warnings } = sanitizeWeaponAwakening(special, normal);
    expect(record.has_weapon_awakening).toBe(false);
    expect(record.awakening_after_weapon).toBe("");
    expect(record.awakening_skill_name).toBe("浄三業");
    expect(warnings).toHaveLength(1);
  });
  it("特異武将固有の武器覚醒は残す", () => {
    const special = {
      ...emptyWarlordInput(),
      is_special: true,
      awakening_skill_name: "別覚醒",
      has_weapon_awakening: true,
      awakening_after_weapon: "特異固有の効果",
    };
    expect(sanitizeWeaponAwakening(special, normal).record.has_weapon_awakening).toBe(true);
  });
  it("通常武将には適用しない", () => {
    const n = { ...emptyWarlordInput(), has_weapon_awakening: true, awakening_after_weapon: "焦熱獄+ の効果" };
    expect(sanitizeWeaponAwakening(n, { ...normal, is_special: true }).record.has_weapon_awakening).toBe(true);
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
    expect(splitAwakeningName("焦熱獄（高）")).toEqual({ name: "焦熱獄", priority: "高" });
  });
});
