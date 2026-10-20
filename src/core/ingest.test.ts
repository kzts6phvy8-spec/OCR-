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
