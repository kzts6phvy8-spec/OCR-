// 鬼憑武将の連携スキルの共有。
// 鬼憑武将は毎シーズン 4 人ずつ実装され、連携スキルはその 4 人の間で起こり、書かれている効果も 4 人とも同じ。
// そこで、1 人の連携スキルが読めたら、残りの 3 人にも同じ連携スキルを入れる (まだ入っていない時だけ)。

import type { SynergySkill, Warlord } from "./types.ts";
import type { WarlordRepo } from "./ingest.ts";
import { normalizeInput, partnerKey, splitPartners } from "./domain.ts";

export const ONI_FACTION = "鬼憑武将";

export { partnerKey, splitPartners };

/**
 * 鬼憑武将 w の連携スキルを、同じ組の他の鬼憑武将に広める。広めた (書き換えた) 武将を返す。
 * 組 = w と連携相手。相手が鬼憑武将として登録済みで、その組の連携スキルがまだ無い時だけ足す。
 */
export async function shareOniSynergies(repo: WarlordRepo, w: Warlord): Promise<Warlord[]> {
  if (w.faction !== ONI_FACTION) return [];
  const changed: Warlord[] = [];
  for (const s of w.synergy_skills) {
    if (!s.effect.trim()) continue;
    const group = [...new Set([w.name, ...splitPartners(s.partner)])];
    // 4 人組より大きい組は鬼の連携ではないかもしれないので広めない
    if (group.length < 2 || group.length > 4) continue;
    for (const name of group) {
      if (name === w.name) continue;
      for (const other of await repo.findByName(name)) {
        if (other.faction !== ONI_FACTION || other.is_special !== w.is_special) continue;
        const partner = group.filter((n) => n !== other.name).join("、");
        if (other.synergy_skills.some((x: SynergySkill) => partnerKey(x.partner) === partnerKey(partner))) continue;
        const { id: _i, created_at: _c, updated_at: _u, screenshot_count: _s, ...input } = other;
        const saved = await repo.update(
          other.id,
          normalizeInput({ ...input, synergy_skills: [...other.synergy_skills, { partner, effect: s.effect }] }),
        );
        changed.push(saved);
      }
    }
  }
  return changed;
}
