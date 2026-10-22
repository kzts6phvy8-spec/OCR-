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
 * 立ち絵 (画面左側のキャラクターのイラスト) で、どの武将の画像かを判断する。
 * 戻り値: 一致した武将の id / "none" (立ち絵はあるが、どれとも違う) / null (立ち絵が無い・判断できなかった)
 */
export type VisualMatcher = (candidates: Warlord[]) => Promise<string | "none" | null>;

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
    /** 同じ名前の特異武将がいて、画面に【特】表記が無い時だけ使う */
    matchVisual?: VisualMatcher;
  },
): Promise<IngestResult> {
  const decision = decideSpecial(ext, opts.mode);
  const warnings = [...decision.warnings];
  const readName = normalizeName(ext.name).name;

  let existing: Warlord | null;
  let name: string;
  let isSpecial: boolean;

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

    // 【特】表記が写っていない画面 (天賦だけ等) は通常武将か特異武将か文字ではわからない。
    // 同じ名前の特異武将が登録済みなら、画面左側の立ち絵を登録済みの画像と見比べて判断する。
    if (opts.mode === "auto" && !isSpecial && opts.matchVisual) {
      const special = await repo.find(name, true);
      if (special) {
        const normal = existing;
        const candidates = normal ? [normal, special] : [special];
        let match: string | "none" | null = null;
        try {
          match = await opts.matchVisual(candidates);
        } catch {
          match = null;
        }
        const hit = candidates.find((c) => c.id === match);
        if (hit) {
          existing = hit;
          isSpecial = hit.is_special;
          warnings.push(`【特】表記が無いため、立ち絵から${hit.is_special ? "特異" : "通常"}武将と判断しました`);
        } else if (match === "none") {
          if (normal) warnings.push("立ち絵がどの登録画像とも一致しませんでした。通常武将として統合しました");
          else warnings.push("立ち絵が特異武将と違うため、通常武将として新しく登録しました");
        } else if (!normal) {
          // 判断できない時は、新しく作るより登録済みの特異武将にまとめる
          existing = special;
          isSpecial = true;
          warnings.push("立ち絵で判断できなかったため、同じ名前の特異武将に統合しました (違う場合は武将の画面から直してください)");
        } else {
          warnings.push("立ち絵で通常か特異か判断できなかったため、通常武将に統合しました");
        }
      }
    }
  }

  const patch = extractionToPatch(ext);
  patch.gallery_images = [opts.imageId];
  patch.image_url = opts.imageId;

  const base = existing ? toInput(existing) : { ...emptyWarlordInput(), name, is_special: isSpecial };
  const { merged, warnings: mergeWarnings } = mergeWarlord(base, patch);
  warnings.push(...mergeWarnings.filter((w) => !(opts.faction && w.startsWith("勢力"))));
  // アップロード時に選んだ勢力は、画像の読み取り結果より優先する
  if (opts.faction) merged.faction = opts.faction;

  const record = normalizeInput(merged);
  const warlord = existing ? await repo.update(existing.id, record) : await repo.insert(record);
  return { warlord, merged: Boolean(existing), warnings };
}
