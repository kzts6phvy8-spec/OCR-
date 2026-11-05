// 連携スキルの相手になれる武将。コラボ武将はコラボ武将どうし、鬼憑武将は鬼憑武将どうしでしか連携しない
// (名前が同じでも、通常・特異・鬼・コラボは別の武将なので、相手にはならない)。

import type { Warlord } from "./types.ts";
import { splitPartners } from "./domain.ts";

/** 連携スキルが同じ勢力の中だけで起こる勢力 */
export const CLOSED_SYNERGY_FACTIONS: readonly string[] = ["コラボ武将", "鬼憑武将"];

/** 武将 w の連携スキルの相手として、図鑑に登録されている武将 */
export function synergyPartners(w: Warlord, partner: string, all: Warlord[]): Warlord[] {
  const names = new Set(splitPartners(partner).map((n) => n.replace(/^鬼憑/, "")));
  const closed = CLOSED_SYNERGY_FACTIONS.includes(w.faction);
  return all.filter(
    (p) =>
      p.id !== w.id &&
      names.has(p.name) &&
      (closed ? p.faction === w.faction : !CLOSED_SYNERGY_FACTIONS.includes(p.faction)),
  );
}
