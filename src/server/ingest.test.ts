import { beforeEach, describe, expect, it } from "vitest";
import * as db from "./db.ts";
import { ingestExtraction } from "./ingest.ts";
import { makeExtraction } from "./testUtils.ts";

beforeEach(() => {
  db.openDb(":memory:");
});

const opts = (imageUrl: string, mode: "auto" | "force_normal" | "force_special" = "auto") => ({
  mode,
  targetId: null,
  imageUrl,
});

describe("ingestExtraction", () => {
  it("同一武将の複数スクショを 1 レコードに統合する", () => {
    const a = ingestExtraction(makeExtraction({ name: "【SSR】百地三太夫", level: 80, skill: { name: "忍の術" } }), opts("/uploads/1.png"));
    const b = ingestExtraction(
      makeExtraction({
        name: "百地三太夫",
        talents: [{ star_level: 1, position: "", name: "忍", effect: "計+5", unlocked: true }],
      }),
      opts("/uploads/2.png"),
    );
    expect(a.merged).toBe(false);
    expect(b.merged).toBe(true);
    expect(b.warlord.id).toBe(a.warlord.id);
    expect(b.warlord.gallery_images).toEqual(["/uploads/1.png", "/uploads/2.png"]);
    expect(b.warlord.screenshot_count).toBe(2);
    expect(b.warlord.skill_name).toBe("忍の術");
    expect(db.listWarlords()).toHaveLength(1);
  });

  it("通常と特異は別レコードで、互いに混ざらない", () => {
    ingestExtraction(
      makeExtraction({
        name: "百地三太夫",
        skill: { name: "忍の術" },
        awakening: {
          visible: true,
          skill_name: "焦熱獄(極高)",
          before_weapon_effect: "通常の効果",
          weapon_awakening_visible: true,
          after_weapon_effect: "焦熱獄+ の効果",
        },
      }),
      opts("/uploads/n.png"),
    );
    const special = ingestExtraction(
      makeExtraction({
        name: "百地三太夫",
        skill: { name: "丹波秘術" },
        awakening: { visible: true, skill_name: "浄三業", before_weapon_effect: "特異の効果" },
      }),
      opts("/uploads/s.png"),
    );
    expect(special.warlord.is_special).toBe(true);
    expect(special.merged).toBe(false);
    expect(special.warlord.has_weapon_awakening).toBe(false);
    expect(special.warlord.awakening_after_weapon).toBe("");
    const normal = db.findWarlord("百地三太夫", false)!;
    expect(normal.skill_name).toBe("忍の術");
    expect(normal.has_weapon_awakening).toBe(true);
    expect(normal.gallery_images).toEqual(["/uploads/n.png"]);
  });

  it("通常武将の武器覚醒が特異武将に読み込まれても除去される", () => {
    ingestExtraction(
      makeExtraction({
        name: "百地三太夫",
        awakening: { visible: true, skill_name: "焦熱獄", weapon_awakening_visible: true, after_weapon_effect: "焦熱獄+ の効果" },
      }),
      opts("/uploads/n.png"),
    );
    const res = ingestExtraction(
      makeExtraction({
        name: "百地三太夫",
        awakening: { visible: true, skill_name: "浄三業", weapon_awakening_visible: true, after_weapon_effect: "焦熱獄+ の効果" },
      }),
      opts("/uploads/s.png", "force_special"),
    );
    expect(res.warlord.has_weapon_awakening).toBe(false);
    expect(res.warnings.some((w) => w.includes("武器覚醒を除去"))).toBe(true);
  });

  it("名前が読めない画像は統合先を指定すれば統合できる", () => {
    const w = ingestExtraction(makeExtraction({ name: "井伊直虎" }), opts("/uploads/1.png")).warlord;
    expect(() => ingestExtraction(makeExtraction({}), opts("/uploads/2.png"))).toThrow(/武将名/);
    const res = ingestExtraction(
      makeExtraction({ synergy_skills: [{ partner: "井伊直政", effect: "x" }] }),
      { mode: "auto", targetId: w.id, imageUrl: "/uploads/2.png" },
    );
    expect(res.warlord.id).toBe(w.id);
    expect(res.warlord.synergy_skills).toHaveLength(1);
  });
});
