// 鬼憑武将の連携スキルの共有。
// 鬼憑武将は毎シーズン 4 人ずつ実装され、連携スキルはその 4 人の間で起こり、書かれている効果も 4 人とも同じ。
// そこで、1 人の連携スキルが読めたら、残りの 3 人にも同じ連携スキルを入れる (まだ入っていない時だけ)。

import type { SynergySkill, Warlord } from "./types.ts";
import type { WarlordRepo } from "./ingest.ts";
import { normalizeInput, partnerKey, sameSynergy, splitPartners } from "./domain.ts";
import { seasonInText } from "./seasons.ts";

export const ONI_FACTION = "鬼憑武将";

export { partnerKey, splitPartners };

/**
 * 鬼憑武将の連携スキルとして正しいか。鬼は同じ組の鬼としか連携しないので、
 * 相手や効果に「鬼」(鬼憑徳川四天王 など) が出てこない連携スキルは、同じ名前の通常・特異武将のものが混ざったもの。
 */
export const isOniSynergy = (s: SynergySkill) => /鬼/.test(`${s.partner}${s.effect}`);

/**
 * 鬼憑武将 w から、同じ名前の (鬼ではない) 武将の連携スキルが混ざったものを取り除く。
 * 取り除くのは、「鬼」が出てこない連携スキルのうち、同じ名前の鬼ではない武将にも同じ連携スキルがあるものだけ
 * (確かに混ざったと言えるものだけ。薄い文字の読み残しなどで鬼の連携スキルを消してしまわないように)。
 * 確かめられないもの (鬼ではない武将の方に無いもの) は suspicious として返し、点検で知らせる。
 */
export async function cleanOniSynergies(
  repo: WarlordRepo,
  w: Warlord,
): Promise<{ warlord: Warlord; removed: SynergySkill[]; suspicious: SynergySkill[] }> {
  if (w.faction !== ONI_FACTION) return { warlord: w, removed: [], suspicious: [] };
  const odd = w.synergy_skills.filter((s) => !isOniSynergy(s));
  if (odd.length === 0) return { warlord: w, removed: [], suspicious: [] };
  // 鬼の組の連携スキルが 1 つも無い武将は、鬼ではない (勢力の読み違い) かもしれないので、何も取り除かない
  if (!w.synergy_skills.some(isOniSynergy)) return { warlord: w, removed: [], suspicious: odd };
  const others = (await repo.findByName(w.name)).filter((o) => o.faction !== ONI_FACTION);
  const removed = odd.filter((s) => others.some((o) => o.synergy_skills.some((x) => sameSynergy(x, s))));
  const suspicious = odd.filter((s) => !removed.includes(s));
  if (removed.length === 0) return { warlord: w, removed, suspicious };
  const { id: _i, created_at: _c, updated_at: _u, screenshot_count: _s, ...input } = w;
  const warlord = await repo.update(w.id, normalizeInput({ ...input, synergy_skills: w.synergy_skills.filter((s) => !removed.includes(s)) }));
  return { warlord, removed, suspicious };
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
        if (other.synergy_skills.some((x: SynergySkill) => sameSynergy(x, { partner, effect: s.effect }))) continue;
        const { id: _i, created_at: _c, updated_at: _u, screenshot_count: _s, ...input } = other;
        const saved = await repo.update(
          other.id,
          normalizeInput({ ...input, synergy_skills: [...other.synergy_skills, { partner, effect: s.effect }] }),
        );
        changed.push(saved);
      }
    }
  }
  // 同じシーズンの鬼は、シーズンの名前が書かれた連携スキル (「鬼憑徳川四天王2体以上…」など) が同じなので、それも広める
  if (w.oni_season && repo.list) {
    const seasonal = w.synergy_skills.filter((s) => s.effect.trim() && seasonInText(`${s.partner} ${s.effect}`) === w.oni_season);
    if (seasonal.length) {
      for (const other of await repo.list()) {
        if (other.id === w.id || other.faction !== ONI_FACTION || other.oni_season !== w.oni_season || other.is_special !== w.is_special) continue;
        const add = seasonal.filter((s) => !other.synergy_skills.some((x) => sameSynergy(x, s)));
        if (add.length === 0) continue;
        const { id: _i, created_at: _c, updated_at: _u, screenshot_count: _s, ...input } = other;
        changed.push(await repo.update(other.id, normalizeInput({ ...input, synergy_skills: [...other.synergy_skills, ...add.map((s) => ({ ...s }))] })));
      }
    }
  }
  return changed;
}
