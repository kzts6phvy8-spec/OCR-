import { beforeEach, describe, expect, it } from "vitest";
import { ingestExtraction as ingest } from "./ingest.ts";
import { createMemoryRepo } from "./memoryRepo.ts";
import type { OcrExtraction } from "./ocrSchema.ts";
import { makeExtraction } from "./testUtils.ts";

let repo: ReturnType<typeof createMemoryRepo>;
beforeEach(() => {
  repo = createMemoryRepo();
});

const ingestExtraction = (ext: OcrExtraction, o: Parameters<typeof ingest>[2]) => ingest(repo, ext, o);

const opts = (imageId: string, mode: "auto" | "force_normal" | "force_special" = "auto") => ({
  mode,
  targetId: null,
  imageId,
});

describe("ingestExtraction", async () => {
  it("同一武将の複数スクショを 1 レコードに統合する", async () => {
    const a = await ingestExtraction(makeExtraction({ name: "【SSR】武将A", level: 80, skill: { name: "スキルA" } }), opts("img-1.png"));
    const b = await ingestExtraction(
      makeExtraction({
        name: "武将A",
        talents: [{ star_level: 1, position: "", name: "天賦A", effect: "計+5", unlocked: true }],
      }),
      opts("img-2.png"),
    );
    expect(a.merged).toBe(false);
    expect(b.merged).toBe(true);
    expect(b.warlord.id).toBe(a.warlord.id);
    expect(b.warlord.gallery_images).toEqual(["img-1.png", "img-2.png"]);
    expect(b.warlord.screenshot_count).toBe(2);
    expect(b.warlord.skill_name).toBe("スキルA");
    expect(repo.all()).toHaveLength(1);
  });

  it("【特】表記が無い画面は、同じ名前の特異武将がいれば立ち絵で判断する", async () => {
    await ingestExtraction(makeExtraction({ name: "武将A" }), opts("img-n.png"));
    const special = (await ingestExtraction(makeExtraction({ name: "武将A", special_marker_visible: true }), opts("img-s.png"))).warlord;
    const normal = (await repo.find("武将A", false))!;

    // 立ち絵が特異武将と一致 → 特異武将に統合
    const asked: string[][] = [];
    const toSpecial = await ingestExtraction(makeExtraction({ name: "武将A", talents: [] }), {
      ...opts("img-t1.png"),
      matchVisual: async (c) => (asked.push(c.map((w) => w.id)), special.id),
    });
    expect(asked).toEqual([[normal.id, special.id]]);
    expect(toSpecial.warlord.id).toBe(special.id);
    expect(toSpecial.warnings.join()).toMatch(/立ち絵から特異武将/);

    // 立ち絵が通常武将と一致 → 通常武将に統合
    const toNormal = await ingestExtraction(makeExtraction({ name: "武将A" }), { ...opts("img-t2.png"), matchVisual: async () => normal.id });
    expect(toNormal.warlord.id).toBe(normal.id);

    // 【特】表記があれば立ち絵は見ない
    let called = false;
    await ingestExtraction(makeExtraction({ name: "武将A", special_marker_visible: true }), {
      ...opts("img-t3.png"),
      matchVisual: async () => ((called = true), null),
    });
    expect(called).toBe(false);
  });

  it("特異武将だけが登録済みなら、立ち絵が違えば通常武将を新しく作り、判断できなければ特異武将にまとめる", async () => {
    const special = (await ingestExtraction(makeExtraction({ name: "武将B", special_marker_visible: true }), opts("img-s.png"))).warlord;
    const unknown = await ingestExtraction(makeExtraction({ name: "武将B" }), { ...opts("img-1.png"), matchVisual: async () => null });
    expect(unknown.warlord.id).toBe(special.id);
    const other = await ingestExtraction(makeExtraction({ name: "武将B" }), { ...opts("img-2.png"), matchVisual: async () => "none" });
    expect(other.warlord.is_special).toBe(false);
    expect(other.merged).toBe(false);
  });

  it("通常と特異は別レコードで、互いに混ざらない", async () => {
    await ingestExtraction(makeExtraction({ name: "武将A", skill: { name: "スキルA" } }), opts("img-n.png"));
    const special = await ingestExtraction(
      makeExtraction({ name: "武将A", special_marker_visible: true, skill: { name: "スキルB" } }),
      opts("img-s.png"),
    );
    expect(special.warlord.is_special).toBe(true);
    expect(special.merged).toBe(false);
    expect(special.warlord.skill_name).toBe("スキルB");
    const normal = (await repo.find("武将A", false))!;
    expect(normal.skill_name).toBe("スキルA");
    expect(normal.gallery_images).toEqual(["img-n.png"]);
  });

  it("名前が読めない画像は統合先を指定すれば統合できる", async () => {
    const w = (await ingestExtraction(makeExtraction({ name: "武将A" }), opts("img-1.png"))).warlord;
    await expect(ingestExtraction(makeExtraction({}), opts("img-2.png"))).rejects.toThrow(/武将名/);
    const res = await ingestExtraction(
      makeExtraction({ synergy_skills: [{ partner: "武将B", effect: "x" }] }),
      { mode: "auto", targetId: w.id, imageId: "img-2.png" },
    );
    expect(res.warlord.id).toBe(w.id);
    expect(res.warlord.synergy_skills).toHaveLength(1);
  });
});

describe("アップロード時の勢力指定", () => {
  it("選んだ勢力が読み取り結果より優先される", async () => {
    const res = await ingest(repo, makeExtraction({ name: "武将A", faction: "東海" }), {
      mode: "auto",
      targetId: null,
      imageId: "img-1",
      faction: "奥.関.甲",
    });
    expect(res.warlord.faction).toBe("奥.関.甲");
    expect(res.warnings).toEqual([]);
  });
});
