import { beforeEach, describe, expect, it } from "vitest";
import { ingestExtraction } from "./ingest.ts";
import { createMemoryRepo } from "./memoryRepo.ts";
import { partnerKey, splitPartners } from "./oni.ts";
import { makeExtraction } from "./testUtils.ts";

let repo: ReturnType<typeof createMemoryRepo>;
beforeEach(() => {
  repo = createMemoryRepo();
});
const add = (name: string, imageId: string, synergy?: { partner: string; effect: string }) =>
  ingestExtraction(repo, makeExtraction({ name, faction: "鬼憑武将", synergy_skills: synergy ? [synergy] : [] }), {
    mode: "auto",
    targetId: null,
    imageId,
  });
const synergyOf = async (name: string) => (await repo.findByName(name))[0]?.synergy_skills ?? [];

describe("鬼憑武将の連携スキル", () => {
  it("相手の欄を名前に分ける", () => {
    expect(splitPartners("鬼B、鬼C、鬼D")).toEqual(["鬼B", "鬼C", "鬼D"]);
    expect(partnerKey("鬼C、鬼B")).toBe(partnerKey("鬼B, 鬼C"));
  });

  it("1 人の連携スキルが読めたら、同じ組の登録済みの鬼にも入れる", async () => {
    await add("鬼B", "b");
    await add("鬼C", "c");
    const res = await add("鬼A", "a", { partner: "鬼B、鬼C、鬼D", effect: "4 人が同時に場内にいる場合、攻+20%" });
    expect(res.warnings.join()).toMatch(/鬼B/);
    expect(await synergyOf("鬼B")).toEqual([{ partner: "鬼A、鬼C、鬼D", effect: "4 人が同時に場内にいる場合、攻+20%" }]);
    expect(await synergyOf("鬼C")).toEqual([{ partner: "鬼A、鬼B、鬼D", effect: "4 人が同時に場内にいる場合、攻+20%" }]);
    // 後から登録された鬼にも入る
    await add("鬼D", "d");
    const d = await synergyOf("鬼D");
    expect(d).toHaveLength(1);
    expect(partnerKey(d[0].partner)).toBe(partnerKey("鬼A、鬼B、鬼C"));
    expect(d[0].effect).toBe("4 人が同時に場内にいる場合、攻+20%");
    // 同じ組の連携スキルを並び順違いで読んでも、2 つにならない
    await add("鬼B", "b2", { partner: "鬼D、鬼C、鬼A", effect: "4 人が同時に場内にいる場合、攻+20%" });
    expect(await synergyOf("鬼B")).toHaveLength(1);
  });

  it("鬼憑武将ではない武将には広めない", async () => {
    await ingestExtraction(repo, makeExtraction({ name: "武将X", faction: "東海" }), { mode: "auto", targetId: null, imageId: "x" });
    await add("鬼A", "a", { partner: "武将X", effect: "効果" });
    expect(await synergyOf("武将X")).toEqual([]);
  });

  it("鬼憑武将に混ざった、同じ名前の通常武将の連携スキルだけを取り除く (確かめられないものは残す)", async () => {
    const sakai = { partner: "酒井忠次", effect: "酒井忠次、井伊直政が同時に場内にいる場合、物理攻撃+10%" };
    const normal = (
      await ingestExtraction(repo, makeExtraction({ name: "井伊直政", faction: "東海", synergy_skills: [sakai] }), {
        mode: "auto",
        targetId: null,
        imageId: "n",
      })
    ).warlord;
    const oni = await add("井伊直政", "o", { partner: "鬼憑徳川四天王", effect: "鬼憑徳川四天王2体以上が場内にいる場合、通常攻撃ダメージ+30%" });
    expect(oni.warlord.id).not.toBe(normal.id);
    // 通常武将の連携スキルが鬼の方に混ざった → 取り除く
    const res = await ingestExtraction(repo, makeExtraction({ name: "井伊直政", faction: "鬼憑武将", synergy_skills: [sakai] }), {
      mode: "auto",
      targetId: oni.warlord.id,
      imageId: "o2",
    });
    expect(res.warlord.synergy_skills.map((x) => x.partner)).toEqual(["鬼憑徳川四天王"]);
    expect(res.warnings.join()).toMatch(/取り除きました/);
    // 「鬼」の文字が無くても、通常武将の方に無い連携スキルは消さない (薄い文字の読み取りなど)
    const kept = await ingestExtraction(
      repo,
      makeExtraction({ name: "井伊直政", faction: "鬼憑武将", synergy_skills: [{ partner: "本多忠勝", effect: "本多忠勝と同時に場内にいる場合、防御+10%" }] }),
      { mode: "auto", targetId: oni.warlord.id, imageId: "o3" },
    );
    expect(kept.warlord.synergy_skills.map((x) => x.partner)).toContain("本多忠勝");
  });

  it("鬼の組の連携スキルが 1 つも無い武将からは、何も取り除かない (勢力の読み違いかもしれないため)", async () => {
    const shared = { partner: "出浦盛清", effect: "出浦盛清と同時に場内にいる場合、回避+10%" };
    await ingestExtraction(repo, makeExtraction({ name: "猿飛佐助", faction: "東海", synergy_skills: [shared] }), { mode: "auto", targetId: null, imageId: "n" });
    const sp = await ingestExtraction(
      repo,
      makeExtraction({ name: "猿飛佐助", special_marker_visible: true, faction: "鬼憑武将", synergy_skills: [shared] }),
      { mode: "auto", targetId: null, imageId: "s" },
    );
    expect(sp.warlord.synergy_skills.map((x) => x.partner)).toEqual(["出浦盛清"]);
  });
});
