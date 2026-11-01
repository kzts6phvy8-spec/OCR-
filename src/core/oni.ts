// 鬼憑武将の連携スキルの共有。
// 鬼憑武将は毎シーズン 4 人ずつ実装され、連携スキルはその 4 人の間で起こり、書かれている効果も 4 人とも同じ。
// そこで、1 人の連携スキルが読めたら、残りの 3 人にも同じ連携スキルを入れる (まだ入っていない時だけ)。

import type { SynergySkill, Warlord } from "./types.ts";
import type { WarlordRepo } from "./ingest.ts";
import { normalizeInput, partnerKey, splitPartners } from "./domain.ts";

export const ONI_FACTION = "鬼憑武将";

export { partnerKey, splitPartners };

/**
 * 鬼憑武将の連携スキルとして正しいか。鬼は同じ組の鬼としか連携しないので、
 * 相手や効果に「鬼」(鬼憑徳川四天王 など) が出てこない連携スキルは、同じ名前の通常・特異武将のものが混ざったもの。
 */
export const isOniSynergy = (s: SynergySkill) => /鬼/.test(`${s.partner}${s.effect}`);

/**
 * 鬼憑武将 w から、鬼の連携ではない連携スキルを取り除く。取り除いた連携スキルは、
 * 同じ名前の (鬼ではない) 武将が 1 人だけ登録されていれば、その武将のものなのでそちらへ移す (まだ無ければ)。
 */
export async function cleanOniSynergies(
  repo: WarlordRepo,
  w: Warlord,
): Promise<{ warlord: Warlord; removed: SynergySkill[]; movedTo: Warlord | null }> {
  if (w.faction !== ONI_FACTION) return { warlord: w, removed: [], movedTo: null };
  const removed = w.synergy_skills.filter((s) => !isOniSynergy(s));
  if (removed.length === 0) return { warlord: w, removed, movedTo: null };
  const strip = (x: Warlord) => {
    const { id: _i, created_at: _c, updated_at: _u, screenshot_count: _s, ...input } = x;
    return input;
  };
  const warlord = await repo.update(w.id, normalizeInput({ ...strip(w), synergy_skills: w.synergy_skills.filter(isOniSynergy) }));
  let movedTo: Warlord | null = null;
  const others = (await repo.findByName(w.name)).filter((o) => o.faction !== ONI_FACTION);
  if (others.length === 1) {
    const o = others[0];
    const add = removed.filter((s) => !o.synergy_skills.some((x) => partnerKey(x.partner) === partnerKey(s.partner)));
    movedTo = add.length ? await repo.update(o.id, normalizeInput({ ...strip(o), synergy_skills: [...o.synergy_skills, ...add] })) : o;
  }
  return { warlord, removed, movedTo };
}

/**
 * 鬼憑武将 w の連携スキルを、同じ組の他の鬼憑武将に広める。広めた (書き換えた) 武将を返す。
 * 組 = w と連携相手。相手が鬼憑武将として登録済みで、その組の連携スキルがまだ無い時だけ足す。
 */
export async function shareOniSynergies(repo: WarlordRepo, w: Warlord): Promise<Warlord[]> {
  if (w.faction !== ONI_FACTION) return [];
  const changed: Warlord[] = [];
  for (const s of w.synergy_skills) {
    if (!s.effect.trim() || !isOniSynergy(s)) continue;
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
