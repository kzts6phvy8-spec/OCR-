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
    const a = ingestExtraction(makeExtraction({ name: "【SSR】武将A", level: 80, skill: { name: "スキルA" } }), opts("/uploads/1.png"));
    const b = ingestExtraction(
      makeExtraction({
        name: "武将A",
        talents: [{ star_level: 1, position: "", name: "天賦A", effect: "計+5", unlocked: true }],
      }),
      opts("/uploads/2.png"),
    );
    expect(a.merged).toBe(false);
    expect(b.merged).toBe(true);
    expect(b.warlord.id).toBe(a.warlord.id);
    expect(b.warlord.gallery_images).toEqual(["/uploads/1.png", "/uploads/2.png"]);
    expect(b.warlord.screenshot_count).toBe(2);
    expect(b.warlord.skill_name).toBe("スキルA");
    expect(db.listWarlords()).toHaveLength(1);
  });

  it("通常と特異は別レコードで、互いに混ざらない", () => {
    ingestExtraction(makeExtraction({ name: "武将A", skill: { name: "スキルA" } }), opts("/uploads/n.png"));
    const special = ingestExtraction(
      makeExtraction({ name: "武将A", special_marker_visible: true, skill: { name: "スキルB" } }),
      opts("/uploads/s.png"),
    );
    expect(special.warlord.is_special).toBe(true);
    expect(special.merged).toBe(false);
    expect(special.warlord.skill_name).toBe("スキルB");
    const normal = db.findWarlord("武将A", false)!;
    expect(normal.skill_name).toBe("スキルA");
    expect(normal.gallery_images).toEqual(["/uploads/n.png"]);
  });

  it("名前が読めない画像は統合先を指定すれば統合できる", () => {
    const w = ingestExtraction(makeExtraction({ name: "武将A" }), opts("/uploads/1.png")).warlord;
    expect(() => ingestExtraction(makeExtraction({}), opts("/uploads/2.png"))).toThrow(/武将名/);
    const res = ingestExtraction(
      makeExtraction({ synergy_skills: [{ partner: "武将B", effect: "x" }] }),
      { mode: "auto", targetId: w.id, imageUrl: "/uploads/2.png" },
    );
    expect(res.warlord.id).toBe(w.id);
    expect(res.warlord.synergy_skills).toHaveLength(1);
  });
});
