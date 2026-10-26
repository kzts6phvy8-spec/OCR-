import type { Faction, UploadMode, Warlord, WarlordInput } from "./types.ts";
import {
  decideSpecial,
  emptyWarlordInput,
  extractionToPatch,
  mergeWarlord,
  normalizeFaction,
  normalizeInput,
  normalizeName,
} from "./domain.ts";
import type { OcrExtraction } from "./ocrSchema.ts";

export class IngestError extends Error {}

/** 保存先 (端末内 DB やテスト用のメモリ) の差し替え口 */
export interface WarlordRepo {
  get(id: string): Promise<Warlord | null>;
  /** 同じ名前の武将すべて (通常・特異・姫武将などの別版) */
  findByName(name: string): Promise<Warlord[]>;
  insert(input: WarlordInput): Promise<Warlord>;
  update(id: string, input: WarlordInput): Promise<Warlord>;
}

export function toInput(w: Warlord): WarlordInput {
  const { id: _id, created_at: _c, updated_at: _u, screenshot_count: _s, ...input } = w;
  return input;
}

/**
 * 画像の立ち絵 (画面左側のキャラクターのイラスト) が、登録済みの武将の立ち絵と同じかを調べる。
 * "unknown" は立ち絵が写っていない等で判断できない時。AI に届かない時は例外を投げる (後でやり直す)。
 */
export type ArtCheck = (
  candidate: Warlord,
  /** localOnly: AI に尋ねず端末だけで見比べる / strict: 確信が無くても「違う」は違うとする */
  opts?: { localOnly?: boolean; strict?: boolean },
) => Promise<"same" | "different" | "unknown">;

/**
 * 同じ名前でも別の武将として扱う勢力 (例: 姫武将の「お市」と通常の「お市」は別人)。
 * 勢力が読み取れた時は、この区分が違う武将には統合しない。
 */
export const SEPARATE_FACTIONS: readonly string[] = ["姫武将"];
const factionGroup = (f: string) => (SEPARATE_FACTIONS.includes(f) ? f : "");
/** 読み取った勢力と、登録済みの武将の勢力が両立するか (どちらかが不明なら両立とみなす) */
const factionCompatible = (w: Warlord, faction: string) => !faction || !w.faction || factionGroup(w.faction) === factionGroup(faction);

interface Choice {
  existing: Warlord | null;
  isSpecial: boolean;
  becomesSpecial: boolean;
  warnings: string[];
}
const create = (isSpecial: boolean, warnings: string[] = []): Choice => ({ existing: null, isSpecial, becomesSpecial: false, warnings });
const use = (w: Warlord, warnings: string[] = []): Choice => ({ existing: w, isSpecial: w.is_special, becomesSpecial: false, warnings });

/** 候補それぞれと見比べ、「同じ」と言えた候補と、判断できなかった候補があるかを返す */
async function compareAll(candidates: Warlord[], sameArt: ArtCheck, strict: boolean) {
  const same: Warlord[] = [];
  let unknown = false;
  for (const c of candidates) {
    const r = await sameArt(c, { strict });
    if (r === "same") same.push(c);
    if (r === "unknown") unknown = true;
  }
  return { same, unknown };
}

/**
 * 同じ名前の武将が登録済みの時、立ち絵を見比べて統合先を決める。
 * 名前が同じでも立ち絵が違えば別の武将 (通常 / 特異 / 姫武将などの別版) なので統合しない。
 */
async function chooseByArt(all: Warlord[], marked: boolean, faction: string, sameArt: ArtCheck): Promise<Choice> {
  const candidates = all.filter((c) => factionCompatible(c, faction));
  const name = all[0]?.name ?? "";

  if (marked) {
    // 【特】表記あり: 特異武将の中から選ぶ
    const specials = candidates.filter((c) => c.is_special);
    if (specials.length === 1) return use(specials[0]);
    if (specials.length > 1) {
      const { same } = await compareAll(specials, sameArt, true);
      if (same.length === 1) return use(same[0]);
      if (same.length === 0) return create(true, ["立ち絵が登録済みの特異武将と違うため、別の武将として登録しました"]);
      throw new IngestError(`立ち絵で「${name}」のどの特異武将か判断できませんでした。武将の画面の「スクショを追加して統合」から追加してください`);
    }
    // 特異武将が未登録: 先に【特】表記の無い画面から「通常」として登録されていた同じ立ち絵の武将なら、特異武将に直す
    const { same } = await compareAll(candidates, sameArt, true);
    if (same.length === 1) {
      return {
        existing: same[0],
        isSpecial: true,
        becomesSpecial: true,
        warnings: ["通常武将として登録されていた武将が、立ち絵が同じ【特】表記の画面だったため、特異武将に直しました"],
      };
    }
    return create(true);
  }

  if (candidates.length === 0) return create(false);
  // 新しく登録する時の通常/特異: 勢力が読めていて、同じ勢力の通常武将だけがいるなら、立ち絵が違う方は特異武将。
  // 姫武将などの別区分は特異武将とは別物なので、こうして特異武将にすることはしない
  const newIsSpecial =
    Boolean(faction) &&
    !SEPARATE_FACTIONS.includes(faction) &&
    candidates.every((c) => !c.is_special && c.faction === faction);
  const newWarning = newIsSpecial
    ? "立ち絵が通常武将と違うため、特異武将として登録しました"
    : "立ち絵が同じ名前の武将と違うため、別の武将として登録しました";

  if (candidates.length === 1) {
    // 1 人だけなら、はっきり違う時以外はその武将とみなす (同じ武将が分かれてしまわないように)
    const only = candidates[0];
    const r = await sameArt(only, { strict: false });
    if (r === "same") return use(only);
    if (r === "different") return create(newIsSpecial, [newWarning]);
    return use(only, ["立ち絵が見えず確かめられなかったため、同じ名前の武将に統合しました"]);
  }

  // 2 人以上: 全員と見比べて、同じと言えるのが 1 人だけの時に決める
  const { same, unknown } = await compareAll(candidates, sameArt, true);
  if (same.length === 1) {
    return use(same[0], same[0].is_special ? ["【特】表記が無いため、立ち絵から特異武将と判断しました"] : []);
  }
  if (same.length === 0 && !unknown) return create(newIsSpecial, [newWarning]);
  throw new IngestError(
    `立ち絵で「${name}」のどの武将か判断できませんでした。武将の画面の「スクショを追加して統合」から追加してください`,
  );
}

export interface IngestResult {
  warlord: Warlord;
  merged: boolean;
  warnings: string[];
}

/**
 * 1 枚分の OCR 結果を保存する。
 * 同じ武将 (名前が同じで、立ち絵・通常/特異・勢力の区分も合う) がいれば統合し、いなければ新規作成する。
 * 解析キューは直列実行なので、ここでの読み書きが他と競合することはない。
 */
export async function ingestExtraction(
  repo: WarlordRepo,
  ext: OcrExtraction,
  opts: {
    mode: UploadMode;
    targetId: string | null;
    imageId: string;
    faction?: Faction | "";
    /** 同じ名前の武将が登録済みの時、立ち絵が同じかを調べる (無ければ名前と【特】表記だけで決める) */
    sameArt?: ArtCheck;
    /** 1 文字だけ違う名前の武将 (名前の読み違いの救済用) */
    similarNames?: (name: string) => Promise<Warlord[]>;
  },
): Promise<IngestResult> {
  const readFaction = opts.faction || normalizeFaction(ext.faction);
  // 姫武将などの別区分は特異武将とは別物: AI が姫のマーク等を【特】と取り違えても特異にしない
  // (武将名そのものに【特】が付いている時だけは従う)
  const decision = decideSpecial(
    SEPARATE_FACTIONS.includes(readFaction) ? { ...ext, special_marker_visible: false } : ext,
    opts.mode,
  );
  const warnings = [...decision.warnings];
  const readName = normalizeName(ext.name).name;

  let existing: Warlord | null;
  let name: string;
  let isSpecial: boolean;
  /** 通常武将として登録されていたが、【特】表記の画面と立ち絵が同じだった (= 本当は特異武将) */
  let becomesSpecial = false;

  if (opts.targetId) {
    existing = await repo.get(opts.targetId);
    if (!existing) throw new IngestError("統合先に指定された武将が見つかりません");
    name = existing.name;
    isSpecial = existing.is_special;
    if (readName && readName !== name) warnings.push(`画像の武将名「${readName}」が統合先「${name}」と異なります`);
    if (opts.mode === "auto" && decision.is_special !== isSpecial && decision.reasons.length > 0) {
      warnings.push(`画像は${decision.is_special ? "特異" : "通常"}武将と判定されましたが、指定された統合先に保存しました`);
    }
  } else {
    if (!readName) {
      throw new IngestError("武将名を読み取れませんでした。「統合先の武将」を指定して再解析してください");
    }
    name = readName;
    isSpecial = decision.is_special;
    const faction = readFaction;
    const all = await repo.findByName(name);
    // 立ち絵で確かめない時 (手動で通常/特異を指定した時など) は、名前・通常/特異・勢力の区分が合う武将へ
    existing =
      all.find((w) => w.is_special === isSpecial && factionCompatible(w, faction) && (!faction || w.faction === faction)) ??
      all.find((w) => w.is_special === isSpecial && factionCompatible(w, faction)) ??
      null;
    if (opts.mode === "auto" && opts.sameArt && all.length > 0) {
      const found = await chooseByArt(all, decision.is_special, faction, opts.sameArt);
      existing = found.existing;
      isSpecial = found.isSpecial;
      becomesSpecial = found.becomesSpecial;
      warnings.push(...found.warnings);
    }
    // 新しく登録しようとしている時、1 文字だけ違う名前の武将がいて立ち絵もほぼ同じなら、名前の読み違いとみなして統合する
    if (!existing && opts.sameArt && opts.similarNames) {
      for (const c of await opts.similarNames(name)) {
        if (c.is_special !== isSpecial && opts.mode !== "auto") continue;
        if (!factionCompatible(c, faction)) continue;
        // 別の武将の可能性もあるので、AI には尋ねず、端末での見比べでほぼ同じ絵の時だけ
        if ((await opts.sameArt(c, { localOnly: true })) !== "same") continue;
        warnings.push(`読み取った名前「${name}」は「${c.name}」と 1 文字違いますが、立ち絵が同じなので統合しました`);
        existing = c;
        name = c.name;
        isSpecial = c.is_special;
        break;
      }
    }
  }

  const patch = extractionToPatch(ext);
  patch.gallery_images = [opts.imageId];
  patch.image_url = opts.imageId;

  const base = existing ? { ...toInput(existing), ...(becomesSpecial ? { is_special: true } : {}) } : { ...emptyWarlordInput(), name, is_special: isSpecial };
  const { merged, warnings: mergeWarnings } = mergeWarlord(base, patch);
  warnings.push(...mergeWarnings.filter((w) => !(opts.faction && w.startsWith("勢力"))));
  // アップロード時に選んだ勢力は、画像の読み取り結果より優先する
  if (opts.faction) merged.faction = opts.faction;

  const record = normalizeInput(merged);
  const warlord = existing ? await repo.update(existing.id, record) : await repo.insert(record);
  return { warlord, merged: Boolean(existing), warnings };
}

/** 2 つの名前が 1 文字だけ違うか (置き換え・抜け・余分が 1 つ)。2 文字以下の名前は対象外 */
export function differsByOneChar(a: string, b: string): boolean {
  const x = [...a];
  const y = [...b];
  if (a === b || Math.min(x.length, y.length) < 2 || Math.abs(x.length - y.length) > 1) return false;
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  let j = 0;
  while (j < x.length - i && j < y.length - i && x[x.length - 1 - j] === y[y.length - 1 - j]) j++;
  return x.length - i - j <= 1 && y.length - i - j <= 1;
}
