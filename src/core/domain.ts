// 戦国布武 ドメインロジック: 名前正規化・【特】判定・マージ
// DB や API に依存しない純粋関数のみを置く (ユニットテスト対象)。

import {
  AWAKENING_PRIORITIES,
  FACTIONS,
  RARITIES,
  type Faction,
  type Rarity,
  type SynergySkill,
  type Talent,
  type UploadMode,
  type Warlord,
  type WarlordInput,
} from "./types.ts";
import type { OcrExtraction } from "./ocrSchema.ts";

const SPECIAL_MARKER_RE = /【\s*特\s*】/g;
const RARITY_TAG_RE = /[【\[［]\s*(?:SSR|SR|R|N|SP|UR)\s*[】\]］]/gi;

export function emptyWarlordInput(): WarlordInput {
  return {
    name: "",
    is_special: false,
    title_alias: "",
    rarity: "",
    faction: "",
    level: 0,
    stars: 0,
    growth_total: "",
    attack_base: 0,
    attack_growth: "",
    defense_base: 0,
    defense_growth: "",
    stratagem_base: 0,
    stratagem_growth: "",
    troops_base: 0,
    troops_growth: "",
    skill_name: "",
    skill_gauge: 0,
    skill_desc: "",
    has_awakening: false,
    awakening_skill_name: "",
    awakening_priority: "",
    has_weapon_awakening: false,
    awakening_before_weapon: "",
    awakening_after_weapon: "",
    talents: [],
    troop_type: "",
    troop_variants: [],
    synergy_skills: [],
    image_url: "",
    gallery_images: [],
  };
}

/** 武将名から【SSR】などの接頭辞と【特】表記を除去した基本名を返す */
export function normalizeName(raw: string | null | undefined): {
  name: string;
  hasSpecialMarker: boolean;
} {
  const text = (raw ?? "").normalize("NFKC");
  const hasSpecialMarker = /【\s*特\s*】/.test(text);
  const name = text
    .replace(RARITY_TAG_RE, "")
    .replace(SPECIAL_MARKER_RE, "")
    .replace(/^(?:SSR|SR|SP)\s+/i, "")
    .replace(/[\s　・]+/g, "")
    .trim();
  return { name, hasSpecialMarker };
}

/** 比較用に文字列を正規化 (全角半角・空白・記号の揺れを吸収) */
export function normText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/[\s　「」『』【】、。,.・]/g, "")
    .toLowerCase();
}

export function normalizeRarity(value: string | null | undefined): Rarity | "" {
  const v = (value ?? "").normalize("NFKC").toUpperCase().replace(/[^A-Z]/g, "");
  return (RARITIES as readonly string[]).includes(v) ? (v as Rarity) : "";
}

const FACTION_ALIASES: Record<string, Faction> = {
  奥関甲: "奥.関.甲",
  奥州関東甲信: "奥.関.甲",
  中九: "中.九",
  中国九州: "中.九",
  鬼憑: "鬼憑武将",
  姫: "姫武将",
  限定: "限定武将",
  頂点: "頂点武将",
};

export function normalizeFaction(value: string | null | undefined): Faction | "" {
  const v = (value ?? "").normalize("NFKC").replace(/[\s.・。､、]/g, "");
  if (!v) return "";
  const exact = FACTIONS.find((f) => f.replace(/\./g, "") === v);
  if (exact) return exact;
  return FACTION_ALIASES[v] ?? "";
}

export function normalizePriority(value: string | null | undefined): string {
  const v = (value ?? "").normalize("NFKC").replace(/[\s()（）優先度]/g, "");
  return (AWAKENING_PRIORITIES as readonly string[]).includes(v) ? v : "";
}

/** 覚醒スキル名から「(極高)」などの優先度表記を分離する */
export function splitAwakeningName(raw: string | null | undefined): {
  name: string;
  priority: string;
} {
  const text = (raw ?? "").normalize("NFKC").trim();
  const m = text.match(/^(.*?)[(（]\s*(極高|高|中|低)\s*[)）]\s*$/);
  if (m) return { name: m[1].trim(), priority: m[2] };
  return { name: text, priority: "" };
}

function growthString(value: string | null | undefined): string {
  const v = (value ?? "").normalize("NFKC").replace(/\s/g, "");
  if (!v) return "";
  if (/^\d+(\.\d+)?$/.test(v)) return `+${v}`;
  return v;
}

function int(value: number | null | undefined, min: number, max: number): number {
  if (value == null || !Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function str(value: string | null | undefined): string {
  return (value ?? "").trim();
}

export interface SpecialDecision {
  is_special: boolean;
  reasons: string[];
  warnings: string[];
}

/** 通常 / 特異の判定。手動モード指定が最優先。 */
export function decideSpecial(ext: OcrExtraction, mode: UploadMode): SpecialDecision {
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (ext.special_marker_visible || normalizeName(ext.name).hasSpecialMarker) reasons.push("画面の【特】表記");

  const detected = reasons.length > 0;
  if (mode === "force_normal") {
    if (detected) warnings.push(`強制: 通常武将 を適用 (【特】表記を無視)`);
    return { is_special: false, reasons: ["手動指定: 通常武将"], warnings };
  }
  if (mode === "force_special") {
    return { is_special: true, reasons: ["手動指定: 特異武将"], warnings };
  }
  return { is_special: detected, reasons, warnings };
}

/**
 * OCR 結果をこの画像から確実に読み取れた項目だけの差分 (patch) に変換する。
 * 写っていない項目は patch に含めない (= 既存値を消さない)。
 */
export function extractionToPatch(ext: OcrExtraction): Partial<WarlordInput> {
  const patch: Partial<WarlordInput> = {};
  const set = <K extends keyof WarlordInput>(key: K, value: WarlordInput[K] | "" | 0 | null) => {
    if (value === null || value === "" || value === 0) return;
    if (Array.isArray(value) && value.length === 0) return;
    patch[key] = value as WarlordInput[K];
  };

  set("title_alias", str(ext.title_alias).replace(SPECIAL_MARKER_RE, "").trim());
  set("rarity", normalizeRarity(ext.rarity));
  set("faction", normalizeFaction(ext.faction));
  set("level", int(ext.level, 0, 999));
  if (ext.stars != null) patch.stars = int(ext.stars, 0, 5);

  set("growth_total", str(ext.growth_total).replace(/^\+/, ""));
  set("attack_base", int(ext.attack.base, 0, 99999));
  set("attack_growth", growthString(ext.attack.growth));
  set("defense_base", int(ext.defense.base, 0, 99999));
  set("defense_growth", growthString(ext.defense.growth));
  set("stratagem_base", int(ext.stratagem.base, 0, 99999));
  set("stratagem_growth", growthString(ext.stratagem.growth));
  set("troops_base", int(ext.troops.base, 0, 99999));
  set("troops_growth", growthString(ext.troops.growth));

  set("skill_name", str(ext.skill.name));
  set("skill_gauge", int(ext.skill.gauge, 0, 3));
  set("skill_desc", str(ext.skill.desc));

  const aw = ext.awakening;
  const split = splitAwakeningName(aw.skill_name);
  if (aw.visible && (split.name || str(aw.before_weapon_effect))) {
    patch.has_awakening = true;
    set("awakening_skill_name", split.name);
    set("awakening_priority", normalizePriority(aw.priority) || split.priority);
    set("awakening_before_weapon", str(aw.before_weapon_effect));
  }
  // 武器覚醒は「この画像に実際に写っている」場合だけ採用する
  if (aw.weapon_awakening_visible && str(aw.after_weapon_effect)) {
    patch.has_awakening = true;
    patch.has_weapon_awakening = true;
    patch.awakening_after_weapon = str(aw.after_weapon_effect);
  }

  const talents = ext.talents
    .filter((t) => str(t.name) || str(t.effect))
    .map((t) => ({
      star_level: int(t.star_level, 1, 5),
      position: str(t.position),
      name: str(t.name),
      effect: str(t.effect),
      unlocked: Boolean(t.unlocked),
    }));
  set("talents", talents);

  set("troop_type", str(ext.troop_type));
  set("troop_variants", uniqueStrings(ext.troop_variants));
  set(
    "synergy_skills",
    ext.synergy_skills
      .map((s) => ({ partner: normalizeName(s.partner).name || str(s.partner), effect: str(s.effect) }))
      .filter((s) => s.partner),
  );
  return patch;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = str(v);
    if (t && !seen.has(normText(t))) {
      seen.add(normText(t));
      out.push(t);
    }
  }
  return out;
}

/** スクショで途中が切れることがあるため、長い説明文は「より長い方」を採用する */
const LONG_TEXT_FIELDS = ["skill_desc", "awakening_before_weapon", "awakening_after_weapon"] as const;
/** 既存値を保持し、食い違いは警告だけ出す項目 */
const STABLE_TEXT_FIELDS = [
  "title_alias",
  "rarity",
  "faction",
  "growth_total",
  "attack_growth",
  "defense_growth",
  "stratagem_growth",
  "troops_growth",
  "skill_name",
  "awakening_skill_name",
  "awakening_priority",
] as const;
const STAT_BASE_FIELDS = ["attack_base", "defense_base", "stratagem_base", "troops_base"] as const;

const FIELD_LABELS: Record<string, string> = {
  title_alias: "二つ名",
  rarity: "レアリティ",
  faction: "勢力",
  growth_total: "成長値合計",
  attack_growth: "攻の成長率",
  defense_growth: "防の成長率",
  stratagem_growth: "計の成長率",
  troops_growth: "兵の成長率",
  skill_name: "奥義スキル名",
  awakening_skill_name: "覚醒スキル名",
  awakening_priority: "覚醒優先度",
};

export function mergeTalents(base: Talent[], incoming: Talent[]): Talent[] {
  const result = base.map((t) => ({ ...t }));
  for (const t of incoming) {
    // 同じ星の同名天賦、名前が読めていない側は同じ星の最初の枠と統合する
    const idx = result.findIndex(
      (r) => r.star_level === t.star_level && (normText(r.name) === normText(t.name) || !r.name || !t.name),
    );
    if (idx === -1) {
      result.push({ ...t });
      continue;
    }
    const cur = result[idx];
    result[idx] = {
      star_level: cur.star_level,
      position: cur.position || t.position,
      name: cur.name || t.name,
      effect: t.effect.length > cur.effect.length ? t.effect : cur.effect,
      unlocked: cur.unlocked || t.unlocked,
    };
  }
  return result.sort((a, b) => a.star_level - b.star_level);
}

export function mergeSynergies(base: SynergySkill[], incoming: SynergySkill[]): SynergySkill[] {
  const result = base.map((s) => ({ ...s }));
  for (const s of incoming) {
    const idx = result.findIndex((r) => normText(r.partner) === normText(s.partner));
    if (idx === -1) result.push({ ...s });
    else if (s.effect.length > result[idx].effect.length) result[idx] = { ...result[idx], effect: s.effect };
  }
  return result;
}

/**
 * 既存レコードに patch を安全にマージする。
 * - 空欄は埋める / 既存値は基本的に保持 (誤読による上書きを防ぐ)
 * - Lv・星は大きい方、基礎値は Lv が同じか上がった時だけ更新
 * - 天賦・連携・兵種は統合、画像はギャラリーに追加
 */
export function mergeWarlord(
  existing: WarlordInput,
  patch: Partial<WarlordInput>,
): { merged: WarlordInput; warnings: string[] } {
  const merged: WarlordInput = {
    ...existing,
    talents: existing.talents.map((t) => ({ ...t })),
    troop_variants: [...existing.troop_variants],
    synergy_skills: existing.synergy_skills.map((s) => ({ ...s })),
    gallery_images: [...existing.gallery_images],
  };
  const warnings: string[] = [];

  for (const key of STABLE_TEXT_FIELDS) {
    const next = patch[key];
    if (!next) continue;
    const cur = merged[key];
    if (!cur) (merged as Record<string, unknown>)[key] = next;
    else if (normText(cur) !== normText(next)) {
      warnings.push(`${FIELD_LABELS[key]}が既存値と異なります (既存「${cur}」を保持 / 新「${next}」)`);
    }
  }
  for (const key of LONG_TEXT_FIELDS) {
    const next = patch[key];
    if (next && next.length > merged[key].length) merged[key] = next;
  }

  const prevLevel = merged.level;
  if (patch.level && patch.level > merged.level) merged.level = patch.level;
  if (patch.stars != null && patch.stars > merged.stars) merged.stars = patch.stars;
  for (const key of STAT_BASE_FIELDS) {
    const next = patch[key];
    if (!next) continue;
    if (!merged[key] || (patch.level != null && patch.level >= prevLevel)) merged[key] = next;
  }
  if (patch.skill_gauge && !merged.skill_gauge) merged.skill_gauge = patch.skill_gauge;

  if (patch.has_awakening) merged.has_awakening = true;
  if (patch.has_weapon_awakening) merged.has_weapon_awakening = true;

  if (patch.talents) merged.talents = mergeTalents(merged.talents, patch.talents);
  if (patch.synergy_skills) merged.synergy_skills = mergeSynergies(merged.synergy_skills, patch.synergy_skills);
  if (patch.troop_variants) merged.troop_variants = uniqueStrings([...merged.troop_variants, ...patch.troop_variants]);
  if (patch.troop_type) {
    merged.troop_type = patch.troop_type;
    merged.troop_variants = uniqueStrings([...merged.troop_variants, patch.troop_type]);
  }

  for (const url of patch.gallery_images ?? []) {
    if (!merged.gallery_images.includes(url)) merged.gallery_images.push(url);
  }
  if (!merged.image_url) merged.image_url = patch.image_url || merged.gallery_images[0] || "";

  return { merged, warnings };
}

/** DB に保存する前の最終正規化 (手動編集・インポートにも適用) */
export function normalizeInput(raw: Partial<WarlordInput>): WarlordInput {
  const base = emptyWarlordInput();
  const v = { ...base, ...raw };
  const { name } = normalizeName(v.name);
  const talents = Array.isArray(v.talents) ? v.talents : [];
  const synergies = Array.isArray(v.synergy_skills) ? v.synergy_skills : [];
  const gallery = uniqueStrings(Array.isArray(v.gallery_images) ? v.gallery_images.map(String) : []);
  const out: WarlordInput = {
    name,
    is_special: Boolean(v.is_special),
    title_alias: String(v.title_alias ?? "").trim(),
    rarity: normalizeRarity(String(v.rarity ?? "")),
    faction: normalizeFaction(String(v.faction ?? "")),
    level: int(Number(v.level), 0, 999),
    stars: int(Number(v.stars), 0, 5),
    growth_total: String(v.growth_total ?? "").trim(),
    attack_base: int(Number(v.attack_base), 0, 99999),
    attack_growth: String(v.attack_growth ?? "").trim(),
    defense_base: int(Number(v.defense_base), 0, 99999),
    defense_growth: String(v.defense_growth ?? "").trim(),
    stratagem_base: int(Number(v.stratagem_base), 0, 99999),
    stratagem_growth: String(v.stratagem_growth ?? "").trim(),
    troops_base: int(Number(v.troops_base), 0, 99999),
    troops_growth: String(v.troops_growth ?? "").trim(),
    skill_name: String(v.skill_name ?? "").trim(),
    skill_gauge: int(Number(v.skill_gauge), 0, 3),
    skill_desc: String(v.skill_desc ?? "").trim(),
    has_awakening: Boolean(v.has_awakening),
    awakening_skill_name: String(v.awakening_skill_name ?? "").trim(),
    awakening_priority: normalizePriority(String(v.awakening_priority ?? "")),
    has_weapon_awakening: Boolean(v.has_weapon_awakening),
    awakening_before_weapon: String(v.awakening_before_weapon ?? "").trim(),
    awakening_after_weapon: String(v.awakening_after_weapon ?? "").trim(),
    talents: talents
      .map((t) => ({
        star_level: int(Number(t?.star_level), 1, 5),
        position: String(t?.position ?? "").trim(),
        name: String(t?.name ?? "").trim(),
        effect: String(t?.effect ?? "").trim(),
        unlocked: Boolean(t?.unlocked),
      }))
      .filter((t) => t.name || t.effect)
      .sort((a, b) => a.star_level - b.star_level),
    troop_type: String(v.troop_type ?? "").trim(),
    troop_variants: uniqueStrings(Array.isArray(v.troop_variants) ? v.troop_variants.map(String) : []),
    synergy_skills: synergies
      .map((s) => ({ partner: String(s?.partner ?? "").trim(), effect: String(s?.effect ?? "").trim() }))
      .filter((s) => s.partner),
    image_url: String(v.image_url ?? "").trim() || gallery[0] || "",
    gallery_images: gallery,
  };
  if (out.has_weapon_awakening || out.awakening_after_weapon || out.awakening_skill_name) out.has_awakening = true;
  return out;
}

export function warlordLabel(w: { name: string; is_special: boolean }): string {
  return w.is_special ? `【特】${w.name}` : w.name;
}
