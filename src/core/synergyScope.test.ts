import { describe, expect, it } from "vitest";
import { emptyWarlordInput, normalizeInput } from "./domain.ts";
import { synergyPartners } from "./synergyScope.ts";
import type { Warlord, WarlordInput } from "./types.ts";

let n = 0;
const w = (input: Partial<WarlordInput>): Warlord => ({
  ...normalizeInput({ ...emptyWarlordInput(), ...input }),
  id: `w${++n}`,
  screenshot_count: 0,
  created_at: "",
  updated_at: "",
});

describe("連携スキルの相手", () => {
  it("コラボ武将はコラボ武将と、鬼は鬼と、それ以外はそれ以外とだけ連携する", () => {
    const collabA = w({ name: "A", faction: "コラボ武将" });
    const collabB = w({ name: "B", faction: "コラボ武将" });
    const normalB = w({ name: "B", faction: "東海" });
    const specialB = w({ name: "B", faction: "東海", is_special: true });
    const oniB = w({ name: "B", faction: "鬼憑武将" });
    const normalA = w({ name: "A", faction: "東海" });
    const all = [collabA, collabB, normalB, specialB, oniB, normalA];
    expect(synergyPartners(collabA, "B", all).map((p) => p.id)).toEqual([collabB.id]);
    expect(synergyPartners(normalA, "B", all).map((p) => p.id)).toEqual([normalB.id, specialB.id]);
    expect(synergyPartners(w({ name: "C", faction: "鬼憑武将" }), "鬼憑B", all).map((p) => p.id)).toEqual([oniB.id]);
  });
});
