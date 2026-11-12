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

    it("物語武将はレア度が違えば、立ち絵が同じでも別の武将にする", async () => {
      const ssr = (await add("m1", { faction: "物語武将", rarity: "SSR" })).warlord;
      const sr = await add("m2", { faction: "物語武将", rarity: "SR" }); // 同じ立ち絵 (m)
      expect(sr.merged).toBe(false);
      expect(sr.warlord.id).not.toBe(ssr.id);
      expect(sr.warlord.is_special).toBe(false);
      // レア度が読めた画面は、そのレア度の武将へ
      expect((await add("m3", { rarity: "SSR" })).warlord.id).toBe(ssr.id);
      expect((await add("m4", { rarity: "SR" })).warlord.id).toBe(sr.warlord.id);
      // レア度も勢力も写っていない画面は、立ち絵が同じで見分けられないので判断を求める
      await expect(add("m5")).rejects.toThrow(/判断できませんでした/);
      // 物語武将以外は、レア度の読み違いがあっても立ち絵が同じなら統合する
      const n = (await ingestExtraction(makeExtraction({ name: "武将Z", faction: "東海", rarity: "SSR" }), { ...opts("z1"), sameArt: art("z1") })).warlord;
      const z = await ingestExtraction(makeExtraction({ name: "武将Z", rarity: "SR" }), { ...opts("z2"), sameArt: art("z2") });
      expect(z.warlord.id).toBe(n.id);
    });

    it("鬼憑武将は、同じ名前の通常・特異武将と統合しない", async () => {
      const normal = (await add("n1", { faction: "東海" })).warlord;
      const special = (await add("s1", { faction: "東海", special_marker_visible: true })).warlord;
      // 立ち絵の判定が「同じ」でも、勢力が鬼憑武将と読めたら別の武将
      const oni = await ingestExtraction(makeExtraction({ name: "武将A", faction: "鬼憑武将" }), { ...opts("n2"), sameArt: async () => "same" });
      expect(oni.merged).toBe(false);
      expect([normal.id, special.id]).not.toContain(oni.warlord.id);
      // 通常武将の画面は鬼憑武将に統合しない
      const back = await ingestExtraction(makeExtraction({ name: "武将A", faction: "東海" }), { ...opts("n3"), sameArt: art("n3") });
      expect(back.warlord.id).toBe(normal.id);
    });

    it("同じ名前の特異武将が何人もいても、立ち絵で分ける", async () => {
      const s1 = (await add("s1", { special_marker_visible: true })).warlord;
      const t1 = await add("t1", { special_marker_visible: true }); // 違う立ち絵の特異武将
      expect(t1.merged).toBe(false);
      expect(t1.warlord.is_special).toBe(true);
      expect(t1.warlord.id).not.toBe(s1.id);
      // それぞれの立ち絵の画面は、それぞれの特異武将へ
      expect((await add("s2", { special_marker_visible: true })).warlord.id).toBe(s1.id);
      expect((await add("t2", { special_marker_visible: true })).warlord.id).toBe(t1.warlord.id);
      expect(repo.all().filter((w) => w.is_special)).toHaveLength(2);
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

  it("新しく作ったばかりの統合先は、通常/特異を読み取り結果に合わせる", async () => {
    const w = await repo.insert({ ...(await import("./domain.ts")).emptyWarlordInput(), name: "武将N", is_special: false });
    const res = await ingestExtraction(makeExtraction({ name: "武将N", special_marker_visible: true }), {
      mode: "auto",
      targetId: w.id,
      imageId: "n1",
      adoptSpecial: true,
    });
    expect(res.warlord.is_special).toBe(true);
    // 画像がある武将には合わせない
    const res2 = await ingestExtraction(makeExtraction({ name: "武将N" }), { mode: "auto", targetId: w.id, imageId: "n2", adoptSpecial: true });
    expect(res2.warlord.is_special).toBe(true);
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

describe("名将修行の画面", () => {
  const training = makeExtraction({
    name: null,
    meisho_training: { visible: true, selected_rank: "少納言", selected_slot: "下", effect: "計略防御+8%", trained: true },
  });
  it("立ち絵で見分けた名将に追加天賦を足し、登録画像には入れない", async () => {
    const nanbu = await ingestExtraction(makeExtraction({ name: "南部晴政", meisho_marker_visible: true }), opts("skill.png"));
    const r = await ingestExtraction(training, { ...opts("train.png"), identifyMeisho: async () => repo.all().find((w) => w.id === nanbu.warlord.id) ?? null });
    expect(r.warlord.id).toBe(nanbu.warlord.id);
    expect(r.warlord.meisho_talents).toEqual([{ rank: "少納言", slot: "下", effect: "計略防御+8%", trained: true }]);
    expect(r.warlord.gallery_images).toEqual(["skill.png"]);
  });
  it("同じ官職の丸に違う追加天賦が入っていたら、新しく読んだ方で置き換えて知らせる", async () => {
    const nanbu = await ingestExtraction(makeExtraction({ name: "南部晴政", meisho_marker_visible: true }), opts("skill.png"));
    const find = async () => repo.all().find((w) => w.id === nanbu.warlord.id) ?? null;
    await ingestExtraction(training, { ...opts("train-1.png"), identifyMeisho: find });
    const other = makeExtraction({
      name: null,
      meisho_training: { visible: true, selected_rank: "少納言", selected_slot: "下", effect: "物理攻撃+10%", trained: true },
    });
    const r = await ingestExtraction(other, { ...opts("train-2.png"), identifyMeisho: find });
    expect(r.warnings.some((w) => w.includes("置き換えました"))).toBe(true);
    expect(r.warlord.meisho_talents).toEqual([{ rank: "少納言", slot: "下", effect: "物理攻撃+10%", trained: true }]);
  });
  it("見分けられなければ統合先を選んでもらう", async () => {
    await expect(ingestExtraction(training, { ...opts("train.png"), identifyMeisho: async () => null })).rejects.toThrow("どの名将か選ぶ");
  });
});

describe("頂点武将の頂天突破の画面", () => {
  const apex = (title: string, effect: string, cost: number | null) =>
    makeExtraction({ name: null, apex_breakthrough: { visible: true, selected_area: null, selected_size: null, title, effect, cost } });
  const date = () =>
    ingestExtraction(
      makeExtraction({ name: "伊達政宗", faction: "頂点武将", passive_skill: { visible: true, desc: "敵が奥義スキルを発動する度に、通常攻撃ダメージ+5%(最大10回重複可能)" } }),
      opts("skill.png"),
    );
  it("頂点武将が 1 人なら、立ち絵がはっきり違わなければその武将に入れ、必要数から官職を決める", async () => {
    const d = await date();
    expect(d.warlord.passive_skill).toContain("通常攻撃ダメージ+5%");
    const r = await ingestExtraction(apex("追加天賦", "防+40. 兵+40. (未突破)", 25), { ...opts("apex-1.png"), sameArt: async () => "unknown" });
    expect(r.warlord.id).toBe(d.warlord.id);
    expect(r.warlord.apex_nodes).toEqual([{ rank: "少史", size: "小", title: "追加天賦", effect: "防+40. 兵+40", cost: 25 }]);
    expect(r.warlord.apex_images).toEqual(["apex-1.png"]);
    expect(r.warlord.gallery_images).toEqual(["skill.png"]);
    const s = await ingestExtraction(apex("突破スキル(辛·8)", "味方が通常攻撃でダメージを与えた後、追撃を発動.", 50), { ...opts("apex-2.png"), sameArt: async () => "unknown" });
    expect(s.warlord.apex_nodes?.[0]).toMatchObject({ rank: "少史", size: "大" });
    expect(s.warlord.awakening_priority).toBe("辛・8");
    expect(s.warlord.has_awakening).toBe(true);
    const t = await ingestExtraction(apex("【強化】受動スキル", "敵が覚醒スキルを発動する度に…", null), { ...opts("apex-3.png"), sameArt: async () => "unknown" });
    expect(t.warlord.apex_nodes?.map((n) => `${n.rank}${n.size}`)).toEqual(["少史大", "少史小", "大輔大"]);
  });
  it("頂点武将がいなければ、統合先を選んでもらう", async () => {
    await expect(ingestExtraction(apex("追加天賦", "攻+40. 計+40", 25), { ...opts("apex.png"), sameArt: async () => "same" })).rejects.toThrow("統合先を選んで保存");
  });
  it("頂点武将が 2 人以上いて、立ち絵で 1 人に決まればその武将", async () => {
    await date();
    const imagawa = await ingestExtraction(makeExtraction({ name: "今川義元", faction: "頂点武将" }), opts("imagawa.png"));
    const r = await ingestExtraction(apex("追加天賦", "ダメージ+25%", 45), {
      ...opts("apex.png"),
      sameArt: async (c: Warlord) => (c.id === imagawa.warlord.id ? "same" : "different"),
    });
    expect(r.warlord.id).toBe(imagawa.warlord.id);
    expect(r.warlord.apex_nodes?.[0]).toMatchObject({ rank: "少納言", size: "小" });
  });
});
