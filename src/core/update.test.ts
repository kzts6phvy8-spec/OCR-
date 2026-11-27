import { describe, expect, it } from "vitest";
import { diffUpdate, makeBaseline, updateToText } from "./update.ts";
import { detectSeason } from "./seasons.ts";
import type { Warlord } from "./types.ts";
import { emptyWarlordInput } from "./domain.ts";

const w = (id: string, o: Partial<Warlord>): Warlord => ({
  ...emptyWarlordInput(),
  id,
  created_at: "",
  updated_at: "",
  screenshot_count: 1,
  ...o,
});

describe("アップデートの変更点", () => {
  it("新しい武将・名前の変更・名将化・鬼のシーズンを見つける", () => {
    const before = [
      w("a", { name: "武田信玄", faction: "奥.関.甲" }),
      w("b", { name: "旧名", faction: "東海" }),
      w("c", { name: "鬼A", faction: "鬼憑武将", oni_season: "源平合戦" }),
      w("e", { name: "上杉謙信", faction: "奥.関.甲", rarity: "SSR" }),
    ];
    const base = makeBaseline(before, "12月アップデート");
    const after = [
      w("a", { name: "武田信玄", faction: "奥.関.甲", is_meisho: true }),
      w("b", { name: "新名", faction: "東海" }),
      w("c", { name: "鬼A", faction: "鬼憑武将", oni_season: "源平合戦" }),
      w("e", { name: "上杉謙信", faction: "奥.関.甲", rarity: "SSR", has_awakening: true, has_weapon_awakening: true, awakening_after_weapon: "物理攻撃+20%" }),
      w("d", {
        name: "鬼B",
        faction: "鬼憑武将",
        synergy_skills: [{ partner: "鬼C", effect: "鬼憑新選組2体以上が同時に場内にいる場合、物理攻撃+10%" }],
      }),
    ];
    const d = diffUpdate(base, after);
    expect(d.added.map((x) => x.name)).toEqual(["鬼B"]);
    expect(d.renamed.map((r) => `${r.from.name}→${r.warlord.name}`)).toEqual(["旧名→新名"]);
    expect(d.newMeisho.map((x) => x.name)).toEqual(["武田信玄"]);
    expect(d.newSeasons).toEqual(["新選組"]);
    expect(d.newWeaponAwakening.map((x) => x.name)).toEqual(["上杉謙信"]);
    const text = updateToText(base, d, (x) => x.name);
    expect(text).toContain("新選組: 鬼B");
    expect(text).toContain("旧名");
  });
  it("一覧に無いシーズンも「鬼憑〇〇N体」から読む。「鬼憑武将2体」はシーズンではない", () => {
    const one = (partner: string, effect: string) => detectSeason([{ partner, effect }]);
    expect(one("鬼A", "鬼憑徳川四天王2体以上が場内にいる場合")).toBe("徳川四天王");
    expect(one("鬼A", "鬼憑新選組4体が同時に場内にいる場合")).toBe("新選組");
    expect(one("鬼A", "鬼憑武将2体以上が場内にいる場合")).toBe("");
    expect(one("鬼憑毛利元就、鬼憑吉川元春", "鬼憑毛利元就、鬼憑吉川元春2体以上が場内にいる場合")).toBe("");
  });
});
