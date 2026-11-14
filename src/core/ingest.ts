import type { Faction, UploadMode, Warlord, WarlordInput } from "./types.ts";
import {
  decideSpecial,
  emptyWarlordInput,
  extractionToPatch,
  mergeWarlord,
  normText,
  normalizeFaction,
  normalizeInput,
  normalizeName,
  normalizeRarity,
} from "./domain.ts";
import type { OcrExtraction } from "./ocrSchema.ts";
import { MAX_IMAGES_PER_WARLORD, hasImageLimit } from "./health.ts";
import { ONI_FACTION, cleanOniSynergies, shareOniSynergies, splitPartners } from "./oni.ts";

export class IngestError extends Error {}

/** 保存先 (端末内 DB やテスト用のメモリ) の差し替え口 */
export interface WarlordRepo {
  get(id: string): Promise<Warlord | null>;
  /** 同じ名前の武将すべて (通常・特異・姫武将などの別版) */
  findByName(name: string): Promise<Warlord[]>;
  /** すべての武将 (鬼憑武将の連携スキルを広めるために使う。無ければその分は行わない) */
  list?(): Promise<Warlord[]>;
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
 * 同じ名前でも別の武将として扱う勢力 (例: 姫武将の「お市」と通常の「お市」、鬼憑武将・限定武将と同じ名前の通常・特異武将は別人)。
 * 勢力が読み取れた時は、この区分が違う武将には統合しない。
 */
export const SEPARATE_FACTIONS: readonly string[] = ["姫武将", "鬼憑武将", "限定武将", "コラボ武将", "旧時代", "頂点武将"];
const factionGroup = (f: string) => (SEPARATE_FACTIONS.includes(f) ? f : "");
/** 読み取った勢力と、登録済みの武将の勢力が両立するか (どちらかが不明なら両立とみなす) */
const factionCompatible = (w: Warlord, faction: string) => !faction || !w.faction || factionGroup(w.faction) === factionGroup(faction);

/**
 * レア度が違えば能力も違うので、同じ名前でも別の武将として扱う勢力 (例: 物語武将の「お宮」の SSR と SR)。
 * 立ち絵が同じでも、レア度が読めて違えば統合しない。
 */
export const SPLIT_BY_RARITY_FACTIONS: readonly string[] = ["物語武将"];
const rarityCompatible = (w: Warlord, faction: string, rarity: string) =>
  !rarity ||
  !w.rarity ||
  w.rarity === rarity ||
  !(SPLIT_BY_RARITY_FACTIONS.includes(faction) || SPLIT_BY_RARITY_FACTIONS.includes(w.faction));
/** 読み取った勢力・レア度と、登録済みの武将が両立するか */
export const compatible = (w: Warlord, faction: string, rarity: string) => factionCompatible(w, faction) && rarityCompatible(w, faction, rarity);

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
async function chooseByArt(all: Warlord[], marked: boolean, faction: string, rarity: string, sameArt: ArtCheck): Promise<Choice> {
  const candidates = all.filter((c) => compatible(c, faction, rarity));
  const name = all[0]?.name ?? "";

  if (marked) {
    // 【特】表記あり: 特異武将の中から選ぶ
    // 同じ名前の特異武将は何人もいることがある (織田信長・塚原卜伝など) ので、1 人だけでも立ち絵を確かめる
    const specials = candidates.filter((c) => c.is_special);
    let newSpecialWarning = "";
    if (specials.length > 0) {
      const { same, unknown } = await compareAll(specials, sameArt, true);
      if (same.length === 1) return use(same[0]);
      if (same.length > 1 || unknown) {
        if (specials.length === 1 && same.length === 0) return use(specials[0], ["立ち絵が見えず確かめられなかったため、同じ名前の特異武将に統合しました"]);
        throw new IngestError(`立ち絵で「${name}」のどの特異武将か判断できませんでした。下の「統合先を選んで保存」で武将を選んでください`);
      }
      newSpecialWarning = "立ち絵が登録済みの特異武将と違うため、別の特異武将として登録しました";
    }
    // 先に【特】表記の無い画面から「通常」として登録されていた同じ立ち絵の武将なら、特異武将に直す
    const { same } = await compareAll(candidates.filter((c) => !c.is_special), sameArt, true);
    if (same.length === 1) {
      return {
        existing: same[0],
        isSpecial: true,
        becomesSpecial: true,
        warnings: ["通常武将として登録されていた武将が、立ち絵が同じ【特】表記の画面だったため、特異武将に直しました"],
      };
    }
    return create(true, newSpecialWarning ? [newSpecialWarning] : []);
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
    `立ち絵で「${name}」のどの武将か判断できませんでした。下の「統合先を選んで保存」で武将を選んでください`,
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
    /** この武将たちには統合しない (立ち絵ごとに分ける時、元の武将に戻らないように) */
    excludeIds?: string[];
    /** 統合先が新しく作ったばかりの (画像の無い) 武将なら、通常/特異を読み取り結果に合わせる */
    adoptSpecial?: boolean;
    /** 1 文字だけ違う名前の武将 (名前の読み違いの救済用) */
    similarNames?: (name: string) => Promise<Warlord[]>;
    /** 名将修行の画面 (武将名が書かれていない) の立ち絵から、登録済みの名将の誰かを見分ける */
    identifyMeisho?: () => Promise<Warlord | null>;
    /** 頂天突破の画面: すでにその頂点武将に振り分けた突破の画面と見比べて誰かを決める (AI なし。分からなければ null) */
    matchKnownApex?: (candidates: Warlord[]) => Promise<Warlord | null>;
    /** 頂天突破・名将の道の画面: 頂点武将が 2 人以上の時、全員の立ち絵を 1 回で見比べて誰かを決める (無ければ 1 人ずつ見比べる) */
    identifyApex?: (candidates: Warlord[]) => Promise<Warlord | null>;
  },
): Promise<IngestResult> {
  const readFaction = opts.faction || normalizeFaction(ext.faction);
  // 姫武将は特異武将とは別物: AI が姫のマーク等を【特】と取り違えても特異にしない
  // (武将名そのものに【特】が付いている時だけは従う)
  const decision = decideSpecial(
    readFaction === "姫武将" ? { ...ext, special_marker_visible: false } : ext,
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
    if (opts.adoptSpecial && existing.gallery_images.length === 0 && decision.is_special !== isSpecial) {
      isSpecial = decision.is_special;
      becomesSpecial = decision.is_special;
      if (!decision.is_special) existing = { ...existing, is_special: false };
    }
    if (readName && readName !== name) warnings.push(`画像の武将名「${readName}」が統合先「${name}」と異なります`);
    if (opts.mode === "auto" && decision.is_special !== isSpecial && decision.reasons.length > 0) {
      warnings.push(`画像は${decision.is_special ? "特異" : "通常"}武将と判定されましたが、指定された統合先に保存しました`);
    }
  } else if (ext.apex_breakthrough?.visible || ext.meisho_awakening?.visible) {
    // 頂点武将の「突破」「名将の道」の画面には武将名が無いので、登録済みの頂点武将の中から立ち絵で決める
    const excluded = new Set(opts.excludeIds ?? []);
    let candidates = repo.list ? (await repo.list()).filter((w) => w.faction === "頂点武将" && !excluded.has(w.id)) : [];
    // 名将の道の画面は、名将の頂点武将 (いまは伊達政宗だけ) の画面
    if (ext.meisho_awakening?.visible && candidates.some((w) => w.is_meisho)) candidates = candidates.filter((w) => w.is_meisho);
    const screen = ext.apex_breakthrough?.visible ? "頂天突破" : "名将の道";
    const pickError = new IngestError(screen + "の画面から、どの頂点武将か見分けられませんでした。下の「統合先を選んで保存」でその頂点武将を選んでください");
    if (candidates.length === 0) {
      throw new IngestError(screen + "の画面ですが、頂点武将がまだ登録されていません。先にその頂点武将のスキル画面などを取り込むか、下の「統合先を選んで保存」で選んでください");
    }
    // 名将の道の画面は、名将の頂点武将が 1 人だけならその武将 (名将の道のカードの絵はスキル画面の立ち絵と違うので見比べない)
    let found = ext.meisho_awakening?.visible && candidates.length === 1 && candidates[0].is_meisho ? candidates[0] : null;
    if (!found && opts.matchKnownApex) found = await opts.matchKnownApex(candidates);
    if (!found && opts.sameArt) {
      if (candidates.length === 1) {
        if ((await opts.sameArt(candidates[0], { strict: false })) === "different") throw pickError;
        found = candidates[0];
      } else if (!opts.identifyApex) {
        const { same } = await compareAll(candidates, opts.sameArt, true);
        if (same.length === 1) found = same[0];
      }
    }
    if (!found && candidates.length > 1 && opts.identifyApex) found = await opts.identifyApex(candidates);
    if (!found) throw pickError;
    existing = found;
    name = found.name;
    isSpecial = found.is_special;
    warnings.push(`${screen}の画面なので、立ち絵から「${found.name}」と判断しました`);
  } else if (!readName && ext.meisho_training?.visible) {
    // 名将修行の画面には武将名が無いので、立ち絵を登録済みの名将と見比べて誰かを決める
    const found = opts.identifyMeisho ? await opts.identifyMeisho() : null;
    if (!found) {
      throw new IngestError("名将修行の画面の立ち絵から、どの名将か見分けられませんでした。下の「どの名将か選ぶ」で選んでください (その名将の名将修行に入れるだけで、武将をまとめるわけではありません)");
    }
    existing = found;
    name = found.name;
    isSpecial = found.is_special;
    warnings.push(`名将修行の画面なので、立ち絵から「${found.is_special ? "【特】" : ""}${found.name}」と判断しました`);
    // 同じ官職の丸に違う追加天賦が入っていたら、新しく読んだ方で置き換える (前の読み取りで位置を読み違えていたことがあるため)
    const read = extractionToPatch(ext).meisho_talents?.[0];
    const old = read && (found.meisho_talents ?? []).find((t) => t.rank === read.rank && t.slot === read.slot && normText(t.effect) !== normText(read.effect));
    if (old) warnings.push(`${old.rank}${old.slot ? ` ${old.slot}` : ""}の「${old.effect}」を「${read.effect}」に置き換えました`);
  } else {
    if (!readName) {
      throw new IngestError("武将名を読み取れませんでした。下の「統合先を選んで保存」で武将を選んでください");
    }
    name = readName;
    isSpecial = decision.is_special;
    const faction = readFaction;
    const rarity = normalizeRarity(ext.rarity);
    const excluded = new Set(opts.excludeIds ?? []);
    const all = (await repo.findByName(name)).filter((w) => !excluded.has(w.id));
    // 立ち絵で確かめない時 (手動で通常/特異を指定した時など) は、名前・通常/特異・勢力の区分が合う武将へ
    existing =
      all.find((w) => w.is_special === isSpecial && compatible(w, faction, rarity) && (!faction || w.faction === faction)) ??
      all.find((w) => w.is_special === isSpecial && compatible(w, faction, rarity)) ??
      null;
    if (opts.mode === "auto" && opts.sameArt && all.length > 0) {
      const found = await chooseByArt(all, decision.is_special, faction, rarity, opts.sameArt);
      existing = found.existing;
      isSpecial = found.isSpecial;
      becomesSpecial = found.becomesSpecial;
      warnings.push(...found.warnings);
    }
    // 新しく登録しようとしている時、1 文字だけ違う名前の武将がいて立ち絵もほぼ同じなら、名前の読み違いとみなして統合する
    if (!existing && opts.sameArt && opts.similarNames) {
      for (const c of await opts.similarNames(name)) {
        if (excluded.has(c.id)) continue;
        if (c.is_special !== isSpecial && opts.mode !== "auto") continue;
        if (!compatible(c, faction, rarity)) continue;
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
  // 名将修行の画面は、追加天賦を読むだけの画面なので登録画像には入れない (立ち絵の見比べ・画像の枚数の数え方を乱さないように)
  // 頂天突破の画面も同じく、頂天突破の画面として別に持つ
  if (ext.apex_breakthrough?.visible) {
    patch.apex_images = [opts.imageId];
    if (!patch.apex_nodes?.length) warnings.push("頂天突破の画面ですが、選ばれている丸の効果を読み取れませんでした");
    else if (!patch.apex_nodes[0].rank) warnings.push(`頂天突破の「${patch.apex_nodes[0].effect}」がどの官職の丸か分かりませんでした (必要数が読めませんでした)`);
  } else if (ext.meisho_awakening?.visible) {
    patch.apex_images = [opts.imageId];
    if (!patch.meisho_awakening?.length) warnings.push("名将の道の画面ですが、選ばれている丸の効果を読み取れませんでした");
  } else if (!ext.meisho_training?.visible) {
    patch.gallery_images = [opts.imageId];
    patch.image_url = opts.imageId;
  } else {
    patch.meisho_images = [opts.imageId];
  }

  const base = existing ? { ...toInput(existing), ...(becomesSpecial ? { is_special: true } : {}) } : { ...emptyWarlordInput(), name, is_special: isSpecial };
  const { merged, warnings: mergeWarnings } = mergeWarlord(base, patch);
  warnings.push(...mergeWarnings.filter((w) => !(opts.faction && w.startsWith("勢力"))));
  // アップロード時に選んだ勢力は、画像の読み取り結果より優先する
  if (opts.faction) merged.faction = opts.faction;
  // 前の版で登録画像に入った頂天突破・名将の道の画面は、読み直したら登録画像から外す
  if (ext.apex_breakthrough?.visible || ext.meisho_awakening?.visible) {
    merged.gallery_images = merged.gallery_images.filter((g) => g !== opts.imageId);
    if (merged.image_url === opts.imageId) merged.image_url = merged.gallery_images[0] ?? "";
  }

  const record = normalizeInput(merged);
  // 天賦がすべて今回の読み取り (画面の位置から星を決める) から入った時は、並びは確かめ済み
  if ((!existing || existing.talents.length === 0) && record.talents.length > 0) {
    record.talent_order_v2 = true;
    record.talent_ai_read = true;
  }
  if (hasImageLimit(record) && record.gallery_images.length > MAX_IMAGES_PER_WARLORD) {
    warnings.push(
      `「${record.name}」の画像が ${record.gallery_images.length} 枚になりました (1 人の武将は多くても ${MAX_IMAGES_PER_WARLORD} 枚)。別の武将の画像が混ざっているかもしれません`,
    );
  }
  const warlord = existing ? await repo.update(existing.id, record) : await repo.insert(record);
  // 鬼憑武将: 同じシーズンの 4 人は連携スキルが共通なので、残りの鬼にも広める (逆に、他の鬼の連携スキルをこの武将にも)
  if (warlord.faction === ONI_FACTION) {
    // 鬼は同じ組の鬼としか連携しない: 同じ名前の通常・特異武将の連携スキルが混ざっていたら取り除く
    const cleaned = await cleanOniSynergies(repo, warlord);
    if (cleaned.removed.length) {
      warnings.push(`同じ名前の鬼ではない武将の連携スキル (${cleaned.removed.map((x) => x.partner).join("、")}) が混ざっていたので取り除きました`);
    }
    const shared = await shareOniSynergies(repo, cleaned.warlord);
    if (shared.length) warnings.push(`連携スキルを同じ組の鬼憑武将 (${shared.map((w) => w.name).join("、")}) にも入れました`);
    for (const w of await oniPartnersOf(repo, warlord)) await shareOniSynergies(repo, w);
    const latest = await repo.get(warlord.id);
    if (latest) return { warlord: latest, merged: Boolean(existing), warnings };
  }
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

/** この鬼憑武将と同じ組の、登録済みの鬼憑武将 (その人の連携スキルをこの武将にも広めるため) */
async function oniPartnersOf(repo: WarlordRepo, w: Warlord): Promise<Warlord[]> {
  const out = new Map<string, Warlord>();
  // この武将が連携相手に挙げている鬼
  for (const name of new Set(w.synergy_skills.flatMap((s) => splitPartners(s.partner)))) {
    for (const o of await repo.findByName(name)) if (o.faction === ONI_FACTION && o.id !== w.id) out.set(o.id, o);
  }
  // この武将を連携相手に挙げている鬼 (この武将の連携スキルがまだ読めていない時など)
  if (repo.list) {
    for (const o of await repo.list()) {
      if (o.faction !== ONI_FACTION || o.id === w.id) continue;
      if (o.synergy_skills.some((s) => splitPartners(s.partner).includes(w.name))) out.set(o.id, o);
    }
  }
  return [...out.values()];
}
