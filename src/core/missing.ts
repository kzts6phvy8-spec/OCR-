// 図鑑の「未入力の項目で絞り込み」に使う項目の一覧。各項目は「まだ入っていない」ことを判定する。

import { AWAKENING_PRIORITIES, type Warlord } from "./types.ts";

export interface MissingField {
  id: string;
  label: string;
  missing: (w: Warlord) => boolean;
}

const blank = (v: string) => !v.trim();

export const MISSING_FIELDS: MissingField[] = [
  { id: "rarity", label: "レア度", missing: (w) => !w.rarity },
  { id: "faction", label: "勢力", missing: (w) => !w.faction },
  { id: "growth_total", label: "成長値", missing: (w) => blank(w.growth_total) },
  { id: "attack", label: "攻", missing: (w) => !w.attack_base || blank(w.attack_growth) },
  { id: "defense", label: "防", missing: (w) => !w.defense_base || blank(w.defense_growth) },
  { id: "stratagem", label: "計", missing: (w) => !w.stratagem_base || blank(w.stratagem_growth) },
  { id: "troops", label: "兵", missing: (w) => !w.troops_base || blank(w.troops_growth) },
  { id: "skill_name", label: "奥義スキル名", missing: (w) => blank(w.skill_name) },
  { id: "skill_gauge", label: "奥義ゲージ", missing: (w) => !w.skill_gauge },
  { id: "skill_desc", label: "奥義スキルの効果", missing: (w) => blank(w.skill_desc) },
  { id: "awakening_skill_name", label: "覚醒スキル名", missing: (w) => blank(w.awakening_skill_name) },
  {
    id: "awakening_priority",
    label: "覚醒スキルの優先度 (甲・1 など)",
    missing: (w) => !AWAKENING_PRIORITIES.includes(w.awakening_priority),
  },
  { id: "awakening_before_weapon", label: "覚醒スキルの効果", missing: (w) => blank(w.awakening_before_weapon) },
  {
    id: "awakening_after_weapon",
    label: "武器覚醒後の効果 (武器覚醒ありの武将)",
    missing: (w) => w.has_weapon_awakening && blank(w.awakening_after_weapon),
  },
  {
    id: "talents",
    label: "天賦 (星1〜5 のどれか)",
    missing: (w) => [1, 2, 3, 4, 5].some((star) => !w.talents.some((t) => t.star_level === star && (t.name || t.effect))),
  },
  { id: "troops_type", label: "兵種", missing: (w) => !w.troop_type && w.troop_variants.length === 0 },
  { id: "synergy", label: "連携スキル", missing: (w) => w.synergy_skills.length === 0 },
];

/** どれか 1 つでも未入力の項目があるか */
export const hasAnyMissing = (w: Warlord) => MISSING_FIELDS.some((f) => f.missing(w));

/** その武将で未入力の項目名の一覧 */
export const missingLabels = (w: Warlord) => MISSING_FIELDS.filter((f) => f.missing(w)).map((f) => f.label);
