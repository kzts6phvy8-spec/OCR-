// 戦国布武 ドメインロジック: 名前正規化・【特】判定・マージ
// DB や API に依存しない純粋関数のみを置く (ユニットテスト対象)。

import {
  AWAKENING_PRIORITIES,
  FACTIONS,
  LEGACY_AWAKENING_PRIORITIES,
  PRIORITY_STEMS,
  RARITIES,
  type Faction,
  type Rarity,
  type SynergySkill,
  type Talent,
  type UploadMode,
  type Warlord,
  type WarlordInput,
} from "./types.ts";
import { inferPriorityFromCondition } from "./priorityRules.ts";
import { detectSeason, normalizeSeason } from "./seasons.ts";
import type { OcrExtraction } from "./ocrSchema.ts";
import { MEISHO_RANKS, type MeishoTalent } from "./types.ts";

const SPECIAL_MARKER_RE = /【\s*特\s*】/g;
/**
 * 名将機能が開放された武将は、奥義スキルの欄の右上に「名将一覧」と書かれている。
 * その文字が武将名・二つ名・奥義スキルに混ざって読まれた時に外す
 * (「〜の名将」のような二つ名もあるので、「名将」だけでは外さない)
 */
const MEISHO_RE = /[【\[(（]?\s*名将一覧\s*[】\])）]?/g;
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
    .replace(MEISHO_RE, "")
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
  物語: "物語武将",
  コラボ: "コラボ武将",
};

export function normalizeFaction(value: string | null | undefined): Faction | "" {
  const v = (value ?? "").normalize("NFKC").replace(/[\s.・。､、]/g, "");
  if (!v) return "";
  const exact = FACTIONS.find((f) => f.replace(/\./g, "") === v);
  if (exact) return exact;
  return FACTION_ALIASES[v] ?? "";
}

/**
 * 発動優先度を「甲・1」〜「癸・10」の形にそろえる。
 * 「甲·1」「甲1」「甲」「1」などの書き方も受け付ける (十干と数字は一対一なので片方から補う)。
 * アップデート前の「極高 / 高 / 中 / 低」は、保存済みのデータのためにそのまま残す。
 */
export function normalizePriority(value: string | null | undefined): string {
  const v = (value ?? "").normalize("NFKC").replace(/[\s()（）]|発動|優先度/g, "");
  if (!v) return "";
  if ((LEGACY_AWAKENING_PRIORITIES as readonly string[]).includes(v)) return v;
  const m = v.match(/^([甲乙丙丁戊己庚辛壬癸])?[・·‧･.\-]?(\d{1,2})?$/);
  if (!m || (!m[1] && !m[2])) return "";
  const index = m[1] ? PRIORITY_STEMS.indexOf(m[1] as (typeof PRIORITY_STEMS)[number]) : Number(m[2]) - 1;
  return AWAKENING_PRIORITIES[index] ?? "";
}

/** 覚醒スキル名から「(甲·1)」「(極高)」などの優先度表記を分離する */
export function splitAwakeningName(raw: string | null | undefined): {
  name: string;
  priority: string;
} {
  const text = (raw ?? "").normalize("NFKC").trim();
  const m = text.match(/^(.*?)[(（]\s*([^()（）]+?)\s*[)）]\s*$/);
  const priority = m ? normalizePriority(m[2]) : "";
  if (m && priority) return { name: m[1].trim(), priority };
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
/** 読み取り結果に「名将一覧」の表記があるか (= 名将機能が開放された武将) */
export function hasMeishoMark(ext: Partial<Pick<OcrExtraction, "name" | "title_alias" | "meisho_marker_visible" | "skill">>): boolean {
  const text = [ext.name, ext.title_alias, ext.skill?.name, ext.skill?.desc].map((v) => v ?? "").join(" ").normalize("NFKC");
  return Boolean(ext.meisho_marker_visible) || /名将一覧/.test(text);
}

/** 「名将一覧」の文字を取り除く */
export const stripMeisho = (text: string) => text.replace(MEISHO_RE, "").trim();

export function extractionToPatch(ext: OcrExtraction): Partial<WarlordInput> {
  const patch: Partial<WarlordInput> = {};
  const set = <K extends keyof WarlordInput>(key: K, value: WarlordInput[K] | "" | 0 | null) => {
    if (value === null || value === "" || value === 0) return;
    if (Array.isArray(value) && value.length === 0) return;
    patch[key] = value as WarlordInput[K];
  };

  set("title_alias", str(ext.title_alias).replace(SPECIAL_MARKER_RE, "").replace(MEISHO_RE, "").trim());
  // 名将: 奥義スキルの欄の右上に「名将一覧」があれば印を付ける (一度付いた印は、写っていない画像で外さない)
  if (hasMeishoMark(ext)) patch.is_meisho = true;
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

  set("skill_name", stripMeisho(str(ext.skill.name)));
  set("skill_gauge", int(ext.skill.gauge, 0, 3));
  set("skill_desc", stripMeisho(str(ext.skill.desc)));

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
      // 星の番号は画面の位置から決める (位置が分からなければ AI の番号のまま。AI の番号の振り方は画像によって違うため)
      star_level: starFromPosition(str(t.position)) ?? int(t.star_level, 1, 5),
      position: "",
      name: "",
      effect: str(t.effect) ? talentEffect(str(t.effect), str(t.name)) : str(t.name),
      unlocked: Boolean(t.unlocked),
    }))
    .filter((t) => t.effect);
  set("talents", talents);

  // 名将修行の追加天賦 (選ばれている丸 1 つ分)
  const mt = ext.meisho_training;
  if (mt?.visible) {
    patch.is_meisho = true;
    const one = normalizeMeishoTalent({ rank: mt.selected_rank, slot: mt.selected_slot, effect: mt.effect, trained: mt.trained });
    if (one) patch.meisho_talents = [one];
  }

  // 兵種は選べる兵種の一覧だけを持つ (「現在の兵種」は持たない)
  set("troop_variants", uniqueStrings([...ext.troop_variants, ...(ext.troop_type ? [str(ext.troop_type)] : [])]));
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

/**
 * 天賦の星の番号。画面の天賦は ①② / ③④ / ⑤ の 3 段に並ぶ (1 段目の左が星1・右が星2、2 段目の左が星3・右が星4、3 段目が星5)。
 * AI が振る番号は画像によって振り方が違う (左の列→右の列の順のこともあれば、正しいこともある) ので、位置から決める。
 */

/** 「1段目左」などの位置から星の番号を決める (分からなければ null) */
export function starFromPosition(position: string): number | null {
  const p = position.normalize("NFKC").replace(/\s/g, "").replace(/一/g, "1").replace(/二/g, "2").replace(/三/g, "3").replace(/四/g, "4").replace(/五/g, "5");
  // 装備の画面の「星一解放:…」のように、星の番号が書かれている時はそのまま
  const star = p.match(/星([1-5])/)?.[1];
  if (star) return Number(star);
  const row = p.match(/([123])段/)?.[1];
  if (!row) return null;
  if (row === "3") return 5;
  if (/左/.test(p)) return row === "1" ? 1 : 3;
  if (/右/.test(p)) return row === "1" ? 2 : 4;
  return null;
}

/**
 * 前の版で、すべての武将にかけてしまった並べ替え (AI の番号 1〜5 → 星 1・3・5・2・4) を元に戻す。
 * 正しかった武将 (お宮など) まで並べ替えてしまったため
 */
const UNDO_REORDER = [0, 1, 4, 2, 5, 3];

/**
 * 左の列を上から (①③⑤)、続けて右の列を上から (②④) 読んだ順に番号が振られた天賦を、星1〜星5 の順に直す
 * (フロイスのように並びがずれている武将だけに、手で使う。データの 1〜5 番目が、実際の星 1・3・5・2・4)
 */
const COLUMN_ORDER_TO_STAR = [0, 1, 3, 5, 2, 4];
export const fixColumnOrderTalents = (talents: Talent[]): Talent[] =>
  talents.map((t) => ({ ...t, star_level: COLUMN_ORDER_TO_STAR[t.star_level] ?? t.star_level })).sort((a, b) => a.star_level - b.star_level);
/**
 * 天賦の並びのずれを、AI を使わずにデータから判断する。
 * 前の版の読み取りには、正しい並び・列の順番 (星 1・3・5・2・4)・左右が逆 (星 2・1・4・3・5) の 3 通りがありうる。
 * 手がかりは 2 つ:
 *  1. 解放済みかどうか: 天賦は星1 から順に解放されるので、「解放済み → 未解放」と前から続く読み方だけが正しい
 *  2. 効果の中身: 見破り・回避・通常会心・スキル会心はだいたい星2、奥義ゲージ・兵数上限はだいたい星3
 * 1 で筋が通る読み方のうち、2 の当たりが一番多いものが 1 つに決まる時だけ決める (決まらなければ "unknown")。
 */
const READ_PATTERNS = { ok: [0, 1, 2, 3, 4, 5], column: COLUMN_ORDER_TO_STAR, swapped: [0, 2, 1, 4, 3, 5] } as const;
export type TalentOrder = keyof typeof READ_PATTERNS | "unknown";

const TYPICAL_STAR: [RegExp, number][] = [
  [/見破り|回避|(?:通常|スキル)会心(?!ダメ)/, 2],
  [/奥義ゲージ|兵数上限|兵力上限/, 3],
];
const typicalStar = (effect: string): number | null => {
  const text = effect.normalize("NFKC");
  return TYPICAL_STAR.find(([re]) => re.test(text))?.[1] ?? null;
};

/** 天賦の効果の種類 (数値や記号を除いたもの)。例: 「物理防御+30%」→「物理防御」 */
export const talentKind = (effect: string): string =>
  effect.normalize("NFKC").replace(/[\d.+\-%()\s、,。]/g, "").replace(/[上昇増加]+$/, "");

/** 並びが確かな武将から学んだ「効果の種類ごとに、星いくつに出やすいか」の数 */
export type TalentStats = Map<string, number[]>;

/** 並びが確かな武将の天賦から、効果の種類ごとの星の出かたを数える */
export function learnTalentStats(lists: Talent[][]): TalentStats {
  const stats: TalentStats = new Map();
  for (const talents of lists) {
    for (const t of talents) {
      if (t.star_level < 1 || t.star_level > 5) continue;
      const kind = talentKind(t.effect);
      if (!kind) continue;
      const counts = stats.get(kind) ?? [0, 0, 0, 0, 0, 0];
      counts[t.star_level]++;
      stats.set(kind, counts);
    }
  }
  return stats;
}

/** 学んだ法則のうち、はっきりしているもの (例: 物理防御は 9 割が星1) */
export function talentRules(stats: TalentStats, minCount = 5, minShare = 0.7): { kind: string; star: number; share: number; count: number }[] {
  const rules: { kind: string; star: number; share: number; count: number }[] = [];
  for (const [kind, counts] of stats) {
    const total = counts.reduce((a, b) => a + b, 0);
    if (total < minCount) continue;
    const star = counts.indexOf(Math.max(...counts.slice(1)), 1);
    const share = counts[star] / total;
    if (share >= minShare) rules.push({ kind, star, share, count: total });
  }
  return rules.sort((a, b) => a.star - b.star || b.count - a.count);
}

/** 3 通りの読み方の確からしさの差がこれ以上 (約 20 倍) の時だけ決める */
const DECIDE_MARGIN = Math.log(20);

/**
 * stats (並びが確かな武将から学んだ法則) を渡すと、効果の中身の判断にそれを使う。
 * 渡さなければ、見破り・奥義ゲージなどの決まった傾向だけで判断する。
 */
export function detectTalentOrder(talents: Talent[], stats?: TalentStats): TalentOrder {
  const stars = talents.map((t) => t.star_level).sort((a, b) => a - b);
  if (stars.join() !== "1,2,3,4,5") return "unknown";
  const fits = (map: readonly number[]) => {
    const flags = talents.map((t) => ({ star: map[t.star_level], unlocked: t.unlocked })).sort((a, b) => a.star - b.star).map((t) => t.unlocked);
    return flags.every((f, i) => i === 0 || !f || flags[i - 1]);
  };
  const candidates = (Object.keys(READ_PATTERNS) as (keyof typeof READ_PATTERNS)[]).filter((k) => fits(READ_PATTERNS[k]));
  if (candidates.length === 0) return "unknown";
  if (candidates.length === 1) return candidates[0];

  if (stats) {
    // 学んだ星の出かた (決まった傾向は 3 回分の下駄をはかせる) から、それぞれの読み方の確からしさを比べる
    const logLikelihood = (map: readonly number[]) =>
      talents.reduce((sum, t) => {
        const counts = [...(stats.get(talentKind(t.effect)) ?? [0, 0, 0, 0, 0, 0])];
        const typical = typicalStar(t.effect);
        if (typical) counts[typical] += 3;
        const total = counts.slice(1).reduce((a, b) => a + b, 0);
        return sum + Math.log((counts[map[t.star_level]] + 0.5) / (total + 2.5));
      }, 0);
    const scored = candidates.map((k) => ({ k, s: logLikelihood(READ_PATTERNS[k]) })).sort((a, b) => b.s - a.s);
    return scored[0].s - scored[1].s >= DECIDE_MARGIN ? scored[0].k : "unknown";
  }

  // 効果の中身の当たり (当たり +1、外れ -1)
  const score = (map: readonly number[]) =>
    talents.reduce((sum, t) => {
      const typical = typicalStar(t.effect);
      return typical === null ? sum : sum + (map[t.star_level] === typical ? 1 : -1);
    }, 0);
  const scored = candidates.map((k) => ({ k, s: score(READ_PATTERNS[k]) })).sort((a, b) => b.s - a.s);
  if (scored[0].s <= 0 || scored[0].s === scored[1].s) return "unknown";
  return scored[0].k;
}

/** detectTalentOrder の結果に合わせて、天賦を星1〜星5 の順に直す */
export const fixTalentOrder = (talents: Talent[], order: TalentOrder): Talent[] =>
  order === "unknown" || order === "ok"
    ? talents
    : talents.map((t) => ({ ...t, star_level: READ_PATTERNS[order][t.star_level] ?? t.star_level })).sort((a, b) => a.star_level - b.star_level);

export const undoTalentReorder = (talents: Talent[]): Talent[] =>
  talents.map((t) => ({ ...t, star_level: UNDO_REORDER[t.star_level] ?? t.star_level })).sort((a, b) => a.star_level - b.star_level);

/** 名将修行の追加天賦を整える (段階が分からない・効果が無いものは null) */
/**
 * 名将修行の丸の位置は、効果の種類でほぼ決まっている (名将 46 人分の実データで確かめた法則)。
 * AI は「どの丸が選ばれているか」を読み違えやすいので、効果から位置が決まる時はそちらを使う。
 * 「最終ダメージ軽減+15%」や兵力の条件付きの効果など、どちらの丸にもあるものは決めない (null)
 */
export function meishoSlotFromEffect(effect: string): { rank: string; slot: string } | null {
  const e = effect.normalize("NFKC").replace(/[\s、,.。]/g, "");
  const at = (rank: string, slot = "") => ({ rank, slot });
  if (/^兵数上限\+175$/.test(e)) return at("少史", "上");
  if (/^(奥義ダメージUP|通常攻撃ダメージ|奥義スキルでの被ダメージ軽減|通常攻撃ダメージ軽減)\+\d+%$/.test(e)) return at("少史", "下");
  if (/^(兵数上限\+20%|奥義ゲージ\+1)$/.test(e)) return at("少納言", "上");
  if (/^物理計略防御\+\d+%$/.test(e)) return at("少納言", "下");
  if (/^(最終ダメージ\+15%|受止め\+25%)$/.test(e)) return at("中納言", "上");
  if (/^(覚醒スキルでの被ダメージ軽減\+\d+%|物理計略攻撃\+\d+%|覚醒スキルダメージUP\+\d+%)$/.test(e)) return at("中納言", "下");
  if (/頓悟/.test(e)) return at("大史");
  if (/覚醒スキル初回発動|味方が通常攻撃をする/.test(e)) return at("大輔");
  if (/奥義スキル初回発動後|初めて回避した後|通常攻撃をする(度|たび)/.test(e)) return at("大史");
  if (/^戦(闘|場)進入時/.test(e)) return at("大輔");
  return null;
}

/** 名将修行の画面で読んだ追加天賦 1 つ (AI が読んだ丸も持つ。効果からの丸と食い違う時に使う) */
export type MeishoRead = MeishoTalent & { aiRank?: string; aiSlot?: string };

/** AI が読んだ丸 (段階と上下) をそろえる (効果からは決めない)。分からなければ null */
export function aiMeishoSlot(rank: unknown, slot: unknown): { rank: string; slot: string } | null {
  const r = String(rank ?? "").normalize("NFKC").replace(/\s/g, "");
  if (!(MEISHO_RANKS as readonly string[]).includes(r)) return null;
  if (r === "大史" || r === "大輔") return { rank: r, slot: "" };
  const s = String(slot ?? "");
  return { rank: r, slot: /下/.test(s) ? "下" : /上/.test(s) ? "上" : "上" };
}

/**
 * 1 人の名将の名将修行の画面で読んだ追加天賦 (画面ごと) から、丸 8 つへの入れ方を決め直す。
 * 入れたい丸の順: 効果から決まる丸 → AI が読んだ丸 → それぞれの相方の丸 (中納言 上⇔下、大史⇔大輔、少史/少納言の上⇔下)。
 * 空いている丸のうち最初のものに入れる (効果から決まるものを先に入れる)。
 * 効果からの丸は名将 46 人分のデータから見つけた法則なので、限定・コラボの名将では外れることがある。その時も丸が空かないように、
 * 埋まっていれば次の候補の丸へ入れる。同じ効果は 1 つにまとめる (修行済みは一度でも修行済みなら修行済み)
 */
export function resolveMeishoSlots(reads: MeishoRead[]): MeishoTalent[] {
  const key = (t: { rank: string; slot: string }) => `${t.rank}|${t.slot}`;
  const partner = (t: { rank: string; slot: string }): { rank: string; slot: string } | null => {
    if (t.rank === "大史") return { rank: "大輔", slot: "" };
    if (t.rank === "大輔") return { rank: "大史", slot: "" };
    if (t.slot === "上") return { rank: t.rank, slot: "下" };
    if (t.slot === "下") return { rank: t.rank, slot: "上" };
    return null;
  };
  // 同じ効果の画面は 1 つにまとめる (AI の読んだ丸は最初のものを使う)
  const uniq: MeishoRead[] = [];
  for (const r of reads) {
    const dup = uniq.find((u) => normText(u.effect) === normText(r.effect));
    if (dup) dup.trained = dup.trained || r.trained;
    else uniq.push({ ...r });
  }
  const prefs = (r: MeishoRead) => {
    const rule = meishoSlotFromEffect(r.effect);
    const ai = r.aiRank ? aiMeishoSlot(r.aiRank, r.aiSlot) : { rank: r.rank, slot: r.slot };
    const list = [rule, ai, rule && partner(rule), ai && partner(ai)].filter((x): x is { rank: string; slot: string } => Boolean(x));
    return list.filter((x, i) => list.findIndex((y) => key(y) === key(x)) === i);
  };
  const placed = new Map<string, MeishoTalent>();
  // 先に入れる順: 効果からの丸と AI の読んだ丸が一致するもの → 効果から丸が決まるもの → それ以外
  const weight = (r: MeishoRead) => {
    const rule = meishoSlotFromEffect(r.effect);
    if (!rule) return 0;
    const ai = r.aiRank ? aiMeishoSlot(r.aiRank, r.aiSlot) : null;
    return ai && key(ai) === key(rule) ? 2 : 1;
  };
  const ordered = [...uniq].sort((a, b) => weight(b) - weight(a));
  for (const r of ordered) {
    const spot = prefs(r).find((p) => !placed.has(key(p)));
    if (spot) placed.set(key(spot), { rank: spot.rank, slot: spot.slot, effect: r.effect, trained: r.trained });
  }
  const order = (t: MeishoTalent) => MEISHO_RANKS.indexOf(t.rank as (typeof MEISHO_RANKS)[number]) * 3 + (t.slot === "下" ? 2 : t.slot === "上" ? 0 : 1);
  return [...placed.values()].sort((a, b) => order(a) - order(b));
}

export function normalizeMeishoTalent(t: { rank?: unknown; slot?: unknown; effect?: unknown; trained?: unknown } | null | undefined): MeishoTalent | null {
  const effect = String(t?.effect ?? "")
    .replace(/[(（]\s*未修行\s*[)）]/g, "")
    .replace(/[.。\s]+$/, "")
    .trim();
  if (!effect) return null;
  const trained = t?.trained !== false && !/未修行/.test(String(t?.effect ?? ""));
  // 効果から位置が決まる時は、AI の読んだ位置より優先する
  const known = meishoSlotFromEffect(effect);
  if (known) return { ...known, effect, trained };
  const rank = String(t?.rank ?? "").normalize("NFKC").replace(/\s/g, "");
  if (!(MEISHO_RANKS as readonly string[]).includes(rank)) return null;
  const s = String(t?.slot ?? "");
  // 丸が 1 つだけの段階 (大史・大輔) は位置を持たない
  const single = rank === "大史" || rank === "大輔";
  const slot = single ? "" : /下/.test(s) ? "下" : /上/.test(s) ? "上" : "";
  return { rank, slot, effect, trained };
}

/** 名将修行の追加天賦をまとめる (同じ段階・位置は新しい方の効果、修行済みは一度でも修行済みなら修行済み)。段階の順に並べる */
export function mergeMeishoTalents(base: MeishoTalent[], incoming: MeishoTalent[]): MeishoTalent[] {
  const map = new Map<string, MeishoTalent>();
  for (const t of [...base, ...incoming]) {
    const key = `${t.rank}|${t.slot}`;
    const cur = map.get(key);
    map.set(key, cur ? { ...t, trained: cur.trained || t.trained } : { ...t });
  }
  const order = (t: MeishoTalent) => MEISHO_RANKS.indexOf(t.rank as (typeof MEISHO_RANKS)[number]) * 3 + (t.slot === "下" ? 2 : t.slot === "上" ? 0 : 1);
  return [...map.values()].sort((a, b) => order(a) - order(b));
}

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

/** 連携相手の欄 (「A、B、C」など) を武将名の一覧にする */
export function splitPartners(partner: string): string[] {
  return partner
    .normalize("NFKC")
    .split(/[、,，/／\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 連携相手の組み合わせが同じかを比べるための鍵 (並び順は問わない) */
export const partnerKey = (partner: string) => splitPartners(partner).map(normText).sort().join("、");

/** 効果の文章の「◯体」(鬼憑武将の連携スキルの段階) */
const tierOf = (effect: string) => effect.normalize("NFKC").match(/(\d+)\s*体/)?.[1] ?? "";

/**
 * 2 つの連携スキルが同じものか。相手 (並び順は問わない) が同じなら同じ連携スキル
 * (読み違い・途切れは長い方を残す)。ただし「◯体」の数が違えば別の段階
 * (例: 鬼憑武将の「1体以上」「2体以上」が場内にいる場合)。
 */
export function sameSynergy(a: SynergySkill, b: SynergySkill): boolean {
  if (partnerKey(a.partner) !== partnerKey(b.partner)) return false;
  const ta = tierOf(a.effect);
  const tb = tierOf(b.effect);
  return !ta || !tb || ta === tb;
}

export function mergeSynergies(base: SynergySkill[], incoming: SynergySkill[]): SynergySkill[] {
  const result = base.map((s) => ({ ...s }));
  for (const s of incoming) {
    const idx = result.findIndex((r) => sameSynergy(r, s));
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

  // アップデート前の優先度表記 (極高 など) は、新しい表記 (甲・1 など) が読めたら置き換える
  if (
    (LEGACY_AWAKENING_PRIORITIES as readonly string[]).includes(merged.awakening_priority) &&
    AWAKENING_PRIORITIES.includes(patch.awakening_priority ?? "")
  ) {
    merged.awakening_priority = patch.awakening_priority!;
  }

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

  if (patch.is_meisho && !merged.meisho_manual) merged.is_meisho = true;
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
  if (patch.meisho_talents?.length) merged.meisho_talents = mergeMeishoTalents(merged.meisho_talents ?? [], patch.meisho_talents);
  if (patch.meisho_images?.length) merged.meisho_images = uniqueStrings([...(merged.meisho_images ?? []), ...patch.meisho_images]);
  if (patch.synergy_skills) merged.synergy_skills = mergeSynergies(merged.synergy_skills, patch.synergy_skills);
  if (patch.troop_variants) merged.troop_variants = uniqueStrings([...merged.troop_variants, ...patch.troop_variants]);

  for (const url of patch.gallery_images ?? []) {
    if (!merged.gallery_images.includes(url)) merged.gallery_images.push(url);
  }
  if (!merged.image_url) merged.image_url = patch.image_url || merged.gallery_images[0] || "";

  return { merged, warnings };
}

/** DB に保存する前の最終正規化 (手動編集・インポートにも適用) */
/**
 * 読み取った天賦の効果を「効果と数値」だけにする。「固守:物理防御+30%」の「固守:」のような先頭の名前を取り除く。
 * AI の読み取り結果にだけ使う (保存済みのデータに何度もかけると、効果の一部まで削ってしまうため)。
 * name: AI が名前として読んだもの。効果の先頭が name ならそれを取り除く。
 * 名前とみなすのは、先頭の短い語 (1〜6 文字) の後に「:」が続き、その後が文字で始まる時だけ
 * (「物理攻撃:+18%」「計略ダメージ:10%軽減」の前半は効果の一部なので残す)。
 */
export function talentEffect(text: string, name = ""): string {
  let t = text.normalize("NFKC").trim();
  const n = name.normalize("NFKC").trim();
  if (n && t !== n && t.startsWith(n)) t = t.slice(n.length).replace(/^[\s:：・]+/, "").trim();
  const m = t.match(/^([^\s:+\-%0-9.]{1,6})\s*[:：]\s*([^\s:+\-%0-9.].*)$/);
  return (m ? m[2] : t).trim();
}

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
        // 天賦は効果と数値だけを持つ (「固守」「気勢」などの名前は持たない)
        position: "",
        name: "",
        // 保存済みの効果は削らない。前の版の「名前だけ」の天賦は、名前を効果の欄に移す
        effect: String(t?.effect ?? "").trim() || String(t?.name ?? "").trim(),
        unlocked: Boolean(t?.unlocked),
      }))
      .filter((t) => t.effect)
      .sort((a, b) => a.star_level - b.star_level),
    // 「現在の兵種」は持たない (前の版で入っていた値は、選べる兵種の一覧に移す)
    troop_type: "",
    troop_variants: uniqueStrings([
      ...(Array.isArray(v.troop_variants) ? v.troop_variants.map(String) : []),
      ...(String(v.troop_type ?? "").trim() ? [String(v.troop_type).trim()] : []),
    ]),
    synergy_skills: synergies
      .map((s) => ({ partner: String(s?.partner ?? "").trim(), effect: String(s?.effect ?? "").trim() }))
      .filter((s) => s.partner),
    no_synergy: Boolean(v.no_synergy),
    is_meisho: Boolean(v.is_meisho),
    meisho_manual: Boolean(v.meisho_manual),
    meisho_training_manual: Boolean(v.meisho_training_manual),
    meisho_images: uniqueStrings(Array.isArray(v.meisho_images) ? v.meisho_images.map(String) : []),
    meisho_talents: mergeMeishoTalents([], (Array.isArray(v.meisho_talents) ? v.meisho_talents : []).map(normalizeMeishoTalent).filter((t): t is MeishoTalent => t !== null)),
    oni_season: normalizeSeason(v.oni_season),
    talent_order_v2: Boolean(v.talent_order_v2),
    talent_reorder_undone: Boolean(v.talent_reorder_undone),
    talent_check_v2: Boolean(v.talent_check_v2),
    talent_ai_read: Boolean(v.talent_ai_read),
    reset_batch: typeof v.reset_batch === "string" ? v.reset_batch : undefined,
    image_url: String(v.image_url ?? "").trim() || gallery[0] || "",
    gallery_images: gallery,
  };
  if (out.has_weapon_awakening || out.awakening_after_weapon || out.awakening_skill_name) out.has_awakening = true;
  // 鬼憑武将のシーズン: 手で選んでいなければ、連携スキルの文章から見つける
  // 鬼憑武将のシーズン: 保存するのは手で選んだものだけ。連携スキルの文章から分かるものは、使う時に毎回見つける
  // (保存すると、連携スキルが直った・取り除かれた後も古いシーズンが残ってしまうため)
  if (out.faction !== "鬼憑武将" || out.oni_season === detectSeason(out.synergy_skills)) out.oni_season = "";
  // 優先度が無い・古い表記 (極高 など) の時は、覚醒スキルの発動条件から一覧表で判断する
  if (!AWAKENING_PRIORITIES.includes(out.awakening_priority)) {
    const inferred = inferPriorityFromCondition(out.awakening_before_weapon || out.awakening_after_weapon);
    if (inferred) out.awakening_priority = inferred;
  }
  return out;
}

export function warlordLabel(w: { name: string; is_special: boolean }): string {
  return w.is_special ? `【特】${w.name}` : w.name;
}
