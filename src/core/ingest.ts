import type { Faction, UploadMode, Warlord, WarlordInput } from "./types.ts";
import {
  decideSpecial,
  emptyWarlordInput,
  extractionToPatch,
  mergeWarlord,
  normalizeInput,
  normalizeName,
} from "./domain.ts";
import type { OcrExtraction } from "./ocrSchema.ts";

export class IngestError extends Error {}

/** 保存先 (端末内 DB やテスト用のメモリ) の差し替え口 */
export interface WarlordRepo {
  get(id: string): Promise<Warlord | null>;
  find(name: string, isSpecial: boolean): Promise<Warlord | null>;
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
export type ArtCheck = (candidate: Warlord) => Promise<"same" | "different" | "unknown">;

/**
 * 同じ名前の武将が登録済みの時、立ち絵を見比べて統合先を決める。
 * 通常武将と特異武将は名前が同じでも立ち絵が違うので、立ち絵が違う武将には統合しない。
 */
async function chooseByArt(
  repo: WarlordRepo,
  name: string,
  marked: boolean,
  sameArt: ArtCheck,
): Promise<{ existing: Warlord | null; isSpecial: boolean; becomesSpecial: boolean; warnings: string[] }> {
  const normal = await repo.find(name, false);
  const special = await repo.find(name, true);

  if (marked) {
    // 【特】表記あり: 特異武将が登録済みならそこへ。
    // 未登録で、通常武将として登録された立ち絵と同じなら、それは先に【特】表記の無い画面から登録された特異武将
    if (special) return { existing: special, isSpecial: true, becomesSpecial: false, warnings: [] };
    if (normal && (await sameArt(normal)) === "same") {
      return {
        existing: normal,
        isSpecial: true,
        becomesSpecial: true,
        warnings: ["通常武将として登録されていた武将が、立ち絵が同じ【特】表記の画面だったため、特異武将に直しました"],
      };
    }
    return { existing: null, isSpecial: true, becomesSpecial: false, warnings: [] };
  }

  const candidates = [normal, special].filter((w): w is Warlord => w !== null);
  if (candidates.length === 0) return { existing: null, isSpecial: false, becomesSpecial: false, warnings: [] };

  const results: ("same" | "different" | "unknown")[] = [];
  for (const c of candidates) {
    const r = await sameArt(c);
    results.push(r);
    if (r === "same") {
      const warnings = c.is_special ? ["【特】表記が無いため、立ち絵から特異武将と判断しました"] : [];
      return { existing: c, isSpecial: c.is_special, becomesSpecial: false, warnings };
    }
  }
  if (results.every((r) => r === "different")) {
    // 登録済みの武将と立ち絵が違う = もう片方 (通常なら特異、特異なら通常)
    if (!special) {
      return { existing: null, isSpecial: true, becomesSpecial: false, warnings: ["立ち絵が通常武将と違うため、特異武将として登録しました"] };
    }
    if (!normal) {
      return { existing: null, isSpecial: false, becomesSpecial: false, warnings: ["立ち絵が特異武将と違うため、通常武将として登録しました"] };
    }
    throw new IngestError(
      `立ち絵が登録済みの「${name}」(通常・特異) のどちらとも一致しません。武将の画面の「スクショを追加して統合」から追加してください`,
    );
  }
  if (candidates.length === 1) {
    // 立ち絵が写っていない画面: 同じ名前の武将が 1 人だけなら、そこにまとめる
    const only = candidates[0];
    return {
      existing: only,
      isSpecial: only.is_special,
      becomesSpecial: false,
      warnings: ["立ち絵が見えず確かめられなかったため、同じ名前の武将に統合しました"],
    };
  }
  throw new IngestError(
    `立ち絵で通常武将か特異武将か判断できませんでした。「${name}」の画面の「スクショを追加して統合」から追加してください`,
  );
}

export interface IngestResult {
  warlord: Warlord;
  merged: boolean;
  warnings: string[];
}

/**
 * 1 枚分の OCR 結果を保存する。
 * 同じ (武将名, 通常/特異) のレコードがあれば統合し、無ければ新規作成する。
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
  },
): Promise<IngestResult> {
  const decision = decideSpecial(ext, opts.mode);
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
    existing = await repo.find(name, isSpecial);
    if (opts.mode === "auto" && opts.sameArt) {
      const found = await chooseByArt(repo, name, decision.is_special, opts.sameArt);
      existing = found.existing;
      isSpecial = found.isSpecial;
      becomesSpecial = found.becomesSpecial;
      warnings.push(...found.warnings);
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
