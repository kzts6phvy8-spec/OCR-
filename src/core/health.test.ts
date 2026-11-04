import { describe, expect, it } from "vitest";
import { emptyWarlordInput, normalizeInput } from "./domain.ts";
import { findIssues } from "./health.ts";
import type { Warlord, WarlordInput } from "./types.ts";

let n = 0;
const w = (input: Partial<WarlordInput>): Warlord => ({
  ...normalizeInput({ ...emptyWarlordInput(), name: "武将A", ...input }),
  id: `w${++n}`,
  screenshot_count: 0,
  created_at: "",
  updated_at: "",
});
const ids = (k: number) => Array.from({ length: k }, (_, i) => `i${i}`);
const kinds = (ws: Warlord[]) => findIssues(ws).map((i) => i.kind);

describe("自動点検", () => {
  it("画像が 7 枚以上と、1 枚だけの武将だけを知らせる", () => {
    expect(kinds([w({ gallery_images: ids(7) })])).toEqual(["too_many_images"]);
    expect(kinds([w({ gallery_images: ids(1) })])).toEqual(["single_image"]);
    for (const k of [0, 2, 6]) expect(kinds([w({ gallery_images: ids(k) })])).toEqual([]);
    // ほかのことは知らせない (同じ名前の武将・読み違いの疑いなど)
    expect(kinds([w({ gallery_images: ids(3), rarity: "SR", awakening_skill_name: "x" }), w({ gallery_images: ids(3) })])).toEqual([]);
  });

  it("鬼の組で、図鑑に登録されていない鬼がいれば知らせる", async () => {
    const { oniGroupName } = await import("./health.ts");
    expect(oniGroupName("鬼憑徳川四天王", "鬼憑徳川四天王2体以上が場内にいる場合、通常攻撃ダメージ+30%")).toBe("鬼憑徳川四天王");
    expect(oniGroupName("", "鬼憑徳川四天王1体以上が場内にいる場合、物理防御+15%")).toBe("鬼憑徳川四天王");
    const syn = (n: number) => ({ partner: "鬼憑徳川四天王", effect: `鬼憑徳川四天王${n}体以上が場内にいる場合、攻+10%` });
    const oni = (name: string) => w({ name, faction: "鬼憑武将", gallery_images: ids(3), synergy_skills: [syn(1), syn(2)] });
    const two = findIssues([oni("井伊直政"), oni("酒井忠次")]).filter((i) => i.kind === "oni_group_incomplete");
    expect(two).toHaveLength(1);
    expect(two[0].message).toMatch(/あと 2 人/);
    expect(kinds([oni("井伊直政"), oni("酒井忠次"), oni("本多忠勝"), oni("榊原康政")])).toEqual([]);
    // 連携相手に名前が並んでいる時は、登録されていない名前を知らせる
    const named = w({ name: "鬼A", faction: "鬼憑武将", gallery_images: ids(3), synergy_skills: [{ partner: "鬼B、鬼C、鬼D", effect: "同時に場内にいる場合、攻+10%" }] });
    const b = w({ name: "鬼B", faction: "鬼憑武将", gallery_images: ids(3) });
    const msgs = findIssues([named, b]).map((i) => i.message).join();
    expect(msgs).toMatch(/鬼C・鬼D/);
  });

  it("組が分からない鬼・勢力が鬼憑武将になっていない武将も知らせる", () => {
    const syn = { partner: "鬼憑徳川四天王", effect: "鬼憑徳川四天王2体以上が場内にいる場合、攻+10%" };
    const msgs = findIssues([
      w({ name: "井伊直政", faction: "鬼憑武将", gallery_images: ids(3), synergy_skills: [syn] }),
      w({ name: "酒井忠次", faction: "東海", gallery_images: ids(3), synergy_skills: [syn] }), // 勢力の読み違い
      w({ name: "本多忠勝", faction: "鬼憑武将", gallery_images: ids(3) }), // 連携スキルがまだ
    ]).map((i) => i.message);
    expect(msgs.join()).toMatch(/酒井忠次」は鬼の組「鬼憑徳川四天王」の連携スキルがあるのに、勢力が「鬼憑武将」になっていません/);
    expect(msgs.join()).toMatch(/鬼「本多忠勝」の連携スキルがまだ読み取れていない/);
    // 勢力の違う武将も組の人数には数える (井伊直政・酒井忠次の 2 人)
    expect(msgs.join()).toMatch(/あと 2 人/);
  });

  it("鬼の組ではない連携スキルしかない鬼憑武将は、勢力の読み違いとして知らせる", () => {
    const msgs = findIssues([
      w({ name: "猿飛佐助", is_special: true, faction: "鬼憑武将", gallery_images: ids(3), synergy_skills: [{ partner: "出浦盛清", effect: "出浦盛清と同時に場内にいる場合、回避+10%" }] }),
    ]).map((i) => i.message);
    expect(msgs.join()).toMatch(/鬼の組ではありません/);
    expect(msgs.join()).not.toMatch(/まだ読み取れていない/);
  });
});
