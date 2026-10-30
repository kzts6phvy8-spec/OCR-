// 図鑑の「未入力の項目で絞り込み」に使う項目の一覧。各項目は「まだ入っていない」ことを判定する。

import { AWAKENING_PRIORITIES, type Warlord } from "./types.ts";

export interface MissingField {
  id: string;
  label: string;
  missing: (w: Warlord) => boolean;
}

const blank = (v: string) => !v.trim();

/** 覚醒スキルの無いレア度 */
const NO_AWAKENING_RARITIES: readonly string[] = ["SR", "R", "N"];
const AWAKENING_FACTIONS: readonly string[] = ["鬼憑武将", "限定武将", "コラボ武将"];

/**
 * 覚醒スキルを持つ武将。SR・R・N には覚醒スキルが無い (勢力に関係なく)。
 * SSR は持つ。レア度が未入力などの時は、鬼憑武将・限定武将・コラボ武将 (限定武将の仲間) なら持つとみなす。
 */
export const hasAwakeningSlot = (w: Warlord) => {
  if (NO_AWAKENING_RARITIES.includes(w.rarity)) return false;
  return w.rarity === "SSR" || AWAKENING_FACTIONS.includes(w.faction);
};

export const MISSING_FIELDS: MissingField[] = [
  { id: "rarity", label: "レア度", missing: (w) => !w.rarity },
  { id: "faction", label: "勢力", missing: (w) => !w.faction },
  { id: "growth_total", label: "成長値の合計", missing: (w) => blank(w.growth_total) },
  {
    id: "stats",
    label: "成長値の攻・防・計・兵",
    missing: (w) =>
      !w.attack_base ||
      blank(w.attack_growth) ||
      !w.defense_base ||
      blank(w.defense_growth) ||
      !w.stratagem_base ||
      blank(w.stratagem_growth) ||
      !w.troops_base ||
      blank(w.troops_growth),
  },
  { id: "skill_desc", label: "奥義スキルの効果", missing: (w) => blank(w.skill_desc) },
  { id: "skill_gauge", label: "奥義ゲージ", missing: (w) => !w.skill_gauge },
  {
    id: "awakening_priority",
    label: "覚醒スキルの優先度",
    missing: (w) => hasAwakeningSlot(w) && !AWAKENING_PRIORITIES.includes(w.awakening_priority),
  },
  {
    id: "awakening_before_weapon",
    label: "覚醒スキルの効果 (SSR のみ)",
    missing: (w) => hasAwakeningSlot(w) && blank(w.awakening_before_weapon),
  },
  {
    id: "awakening_after_weapon",
    label: "武器覚醒後の効果 (武器覚醒ありのみ)",
    missing: (w) => w.has_weapon_awakening && blank(w.awakening_after_weapon),
  },
  {
    id: "talents",
    label: "天賦",
    missing: (w) => [1, 2, 3, 4, 5].some((star) => !w.talents.some((t) => t.star_level === star && (t.name || t.effect))),
  },
  { id: "troops_type", label: "兵種", missing: (w) => !w.troop_type && w.troop_variants.length === 0 },
  { id: "synergy", label: "連携スキル", missing: (w) => w.synergy_skills.length === 0 },
];

/** どれか 1 つでも未入力の項目があるか */
export const hasAnyMissing = (w: Warlord) => MISSING_FIELDS.some((f) => f.missing(w));

/** その武将で未入力の項目名の一覧 */
export const missingLabels = (w: Warlord) => MISSING_FIELDS.filter((f) => f.missing(w)).map((f) => f.label);
