import { beforeEach, describe, expect, it } from "vitest";
import { differsByOneChar, ingestExtraction as ingest } from "./ingest.ts";
import { createMemoryRepo } from "./memoryRepo.ts";
import type { OcrExtraction } from "./ocrSchema.ts";
import type { Warlord } from "./types.ts";
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

  describe("立ち絵で見分ける", () => {
    // 画像 ID の頭文字が同じなら同じ立ち絵とみなす (n = 通常の絵, s = 特異の絵, x = 立ち絵なし)
    const art = (imageId: string) => (c: Warlord) =>
      Promise.resolve(
        imageId.startsWith("x") ? ("unknown" as const) : c.gallery_images.some((g) => g[0] === imageId[0]) ? ("same" as const) : ("different" as const),
      );
    const add = (imageId: string, ext: Parameters<typeof makeExtraction>[0] = {}) =>
      ingestExtraction(makeExtraction({ name: "武将A", ...ext }), { ...opts(imageId), sameArt: art(imageId) });

    it("立ち絵が違えば、名前が同じでも統合しない", async () => {
      const n = (await add("n1", { skill: { name: "通常の奥義" } })).warlord;
      const s = await add("s1", { skill: { name: "特異の奥義" } }); // 【特】表記も勢力も無い画面
      expect(s.merged).toBe(false);
      expect((await repo.get(n.id))!.skill_name).toBe("通常の奥義");
      // 以後、それぞれの絵の画面はそれぞれに統合され、【特】表記の画面が来たら特異武将になる
      expect((await add("s2", { special_marker_visible: true })).warlord).toMatchObject({ id: s.warlord.id, is_special: true });
      expect((await add("n2")).warlord.id).toBe(n.id);
      expect(repo.all()).toHaveLength(2);
      // 勢力が読めていれば、通常武将と違う立ち絵はすぐ特異武将として登録する
      const t = await ingestExtraction(makeExtraction({ name: "武将C", faction: "東海" }), { ...opts("n9"), sameArt: art("n9") });
      const u = await ingestExtraction(makeExtraction({ name: "武将C", faction: "東海" }), { ...opts("s9"), sameArt: art("s9") });
      expect(t.warlord.is_special).toBe(false);
      expect(u.warlord.is_special).toBe(true);
    });

    it("先に【特】表記の無い画面から登録された特異武将は、【特】表記の画面が来たら特異武将に直す", async () => {
      const first = (await add("s1")).warlord;
      expect(first.is_special).toBe(false);
      const marked = await add("s2", { special_marker_visible: true });
      expect(marked.warlord.id).toBe(first.id);
      expect(marked.warlord.is_special).toBe(true);
      // その後の通常の絵は、通常武将として別に登録される
      const normal = await add("n1");
      expect(normal.warlord.is_special).toBe(false);
      expect(normal.merged).toBe(false);
      expect(repo.all()).toHaveLength(2);
    });

    it("立ち絵が見えない画面は、同じ名前が 1 人ならそこへ、2 人なら判断を求める", async () => {
      const n = (await add("n1")).warlord;
      expect((await add("x1")).warlord.id).toBe(n.id);
      await add("s1");
      await expect(add("x2")).rejects.toThrow(/判断できません/);
    });

    it("名前を 1 文字読み違えても、立ち絵が同じなら統合する", async () => {
      const a = (await add("n1")).warlord;
      const res = await ingestExtraction(makeExtraction({ name: "武将Ａ゙" }), {
        ...opts("n2"),
        sameArt: art("n2"),
        similarNames: async (name) => repo.all().filter((w) => differsByOneChar(w.name, name)),
      });
      expect(res.warlord.id).toBe(a.id);
      expect(res.warnings.join()).toMatch(/1 文字違います/);
      expect(differsByOneChar("豊臣秀吉", "豐臣秀吉")).toBe(true);
      expect(differsByOneChar("豊臣秀吉", "豊臣秀長")).toBe(true);
      expect(differsByOneChar("織田信長", "明智光秀")).toBe(false);
      expect(differsByOneChar("信長", "信長公")).toBe(true);
    });

    it("同じ名前の姫武将は、勢力が読めれば立ち絵を見ずに別の武将として登録する", async () => {
      const normal = (await add("n1", { faction: "東海" })).warlord;
      const hime = await add("h1", { faction: "姫武将" });
      expect(hime.merged).toBe(false);
      expect(hime.warlord.id).not.toBe(normal.id);
      expect(hime.warlord.faction).toBe("姫武将");
      // 勢力が写っていない画面 (天賦など) は立ち絵で振り分ける
      expect((await add("h2")).warlord.id).toBe(hime.warlord.id);
      expect((await add("n2")).warlord.id).toBe(normal.id);
    });

    it("姫武将は特異武将にしない", async () => {
      // 勢力が未入力の通常武将がいても、姫武将の画面は特異武将にならない
      await add("n1");
      const hime = await add("h1", { faction: "姫武将", special_marker_visible: true });
      expect(hime.warlord.is_special).toBe(false);
      expect(hime.merged).toBe(false);
      expect(hime.warlord.faction).toBe("姫武将");
      // 勢力が写っていない姫武将の画面も、通常武将と違う立ち絵なら特異にはしない
      await ingestExtraction(makeExtraction({ name: "武将M", faction: "東海" }), { ...opts("m1"), sameArt: art("m1") });
      const other = await ingestExtraction(makeExtraction({ name: "武将M" }), { ...opts("k1"), sameArt: art("k1") });
      expect(other.warlord.is_special).toBe(false);
    });

    it("通常・特異がいて、どちらとも違う立ち絵なら別の武将として登録する", async () => {
      await add("n1");
      await add("s1", { special_marker_visible: true });
      const other = await add("h1");
      expect(other.merged).toBe(false);
      expect(repo.all()).toHaveLength(3);
      expect((await add("h2")).warlord.id).toBe(other.warlord.id);
    });

    it("AI に届かない時は例外のまま (後でやり直す)", async () => {
      await add("n1");
      await expect(
        ingestExtraction(makeExtraction({ name: "武将A" }), { ...opts("n2"), sameArt: () => Promise.reject(new Error("429")) }),
      ).rejects.toThrow("429");
      expect(repo.all()).toHaveLength(1);
    });
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
    const normal = (await repo.findByName("武将A")).find((w) => !w.is_special)!;
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
