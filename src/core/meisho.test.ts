import { describe, expect, it } from "vitest";
import { matchMeishoRoster } from "./meisho.ts";
import { emptyWarlordInput, normalizeInput } from "./domain.ts";
import type { Warlord } from "./types.ts";

const w = (id: string, name: string, faction: string, is_special = false): Warlord =>
  ({ ...normalizeInput({ ...emptyWarlordInput(), name, faction: faction as Warlord["faction"], is_special }), id, created_at: "", updated_at: "", screenshot_count: 1 }) as Warlord;

describe("名将の一覧との突き合わせ", () => {
  it("勢力と名前が合う武将を名将にする (勢力が違えば別人)", () => {
    const m = matchMeishoRoster([w("a", "日野富子", "旧時代"), w("b", "徳川家康", "東海"), w("c", "徳川家康", "奥.関.甲")]);
    expect(m.find((x) => x.name === "日野富子")?.decided.map((x) => x.id)).toEqual(["a"]);
    expect(m.find((x) => x.name === "徳川家康" && x.faction === "東海")?.decided.map((x) => x.id)).toEqual(["b"]);
    expect(m.flatMap((x) => x.decided).some((x) => x.id === "c")).toBe(false);
  });
  it("一覧より候補が多い時は決めない (立ち絵で選んでもらう)", () => {
    const m = matchMeishoRoster([w("a", "織田信長", "東海"), w("b", "織田信長", "東海", true)]);
    const nobu = m.find((x) => x.name === "織田信長" && x.faction === "東海")!;
    expect(nobu.candidates).toHaveLength(2);
    expect(nobu.decided).toHaveLength(0);
  });
  it("一覧に 2 人並ぶ名前は 2 人とも名将", () => {
    const m = matchMeishoRoster([w("a", "江姫", "東海"), w("b", "江姫", "東海", true)]);
    expect(m.find((x) => x.name === "江姫")?.decided).toHaveLength(2);
  });
  it("コラボ武将と限定武将は別の勢力として突き合わせる", () => {
    const m = matchMeishoRoster([w("a", "片倉小十郎", "限定武将"), w("b", "伊達政宗", "コラボ武将")]);
    expect(m.flatMap((x) => x.decided).map((x) => x.id)).toEqual(["b"]);
  });
});
