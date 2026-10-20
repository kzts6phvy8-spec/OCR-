import type { OcrExtraction } from "./ocrSchema.ts";

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** テスト用: 何も写っていない OCR 結果をベースに上書きする */
export function makeExtraction(over: DeepPartial<OcrExtraction> = {}): OcrExtraction {
  const stat = { base: null, growth: null };
  const base: OcrExtraction = {
    screen_types: [],
    name: null,
    title_alias: null,
    rarity: null,
    faction: null,
    level: null,
    stars: null,
    special_evidence: { special_icon_next_to_rating: false, special_text_marker: false, notes: "" },
    growth_total: null,
    attack: { ...stat },
    defense: { ...stat },
    stratagem: { ...stat },
    troops: { ...stat },
    skill: { name: null, gauge: null, desc: null },
    awakening: {
      visible: false,
      skill_name: null,
      priority: null,
      before_weapon_effect: null,
      weapon_awakening_visible: false,
      after_weapon_effect: null,
    },
    talents: [],
    troop_type: null,
    troop_variants: [],
    synergy_skills: [],
  };
  return {
    ...base,
    ...over,
    special_evidence: { ...base.special_evidence, ...over.special_evidence },
    attack: { ...base.attack, ...over.attack },
    defense: { ...base.defense, ...over.defense },
    stratagem: { ...base.stratagem, ...over.stratagem },
    troops: { ...base.troops, ...over.troops },
    skill: { ...base.skill, ...over.skill },
    awakening: { ...base.awakening, ...over.awakening },
  } as OcrExtraction;
}
