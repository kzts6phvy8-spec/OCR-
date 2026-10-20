import type { UploadMode, Warlord, WarlordInput } from "./types.ts";
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
  opts: { mode: UploadMode; targetId: string | null; imageId: string },
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
  }

  const patch = extractionToPatch(ext);
  patch.gallery_images = [opts.imageId];
  patch.image_url = opts.imageId;

  const base = existing ? toInput(existing) : { ...emptyWarlordInput(), name, is_special: isSpecial };
  const { merged, warnings: mergeWarnings } = mergeWarlord(base, patch);
  warnings.push(...mergeWarnings);

  const record = normalizeInput(merged);
  const warlord = existing ? await repo.update(existing.id, record) : await repo.insert(record);
  return { warlord, merged: Boolean(existing), warnings };
}
