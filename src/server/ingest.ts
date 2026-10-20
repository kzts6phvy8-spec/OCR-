import type { UploadMode, Warlord, WarlordInput } from "../shared/types.ts";
import * as db from "./db.ts";
import {
  decideSpecial,
  emptyWarlordInput,
  extractionToPatch,
  mergeWarlord,
  normalizeInput,
  normalizeName,
  sanitizeWeaponAwakening,
  warlordLabel,
} from "./domain.ts";
import type { OcrExtraction } from "./ocrSchema.ts";

export class IngestError extends Error {}

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
 * 1 枚分の OCR 結果を DB に反映する。
 * 同じ (武将名, 通常/特異) のレコードがあれば統合し、無ければ新規作成する。
 */
export function ingestExtraction(
  ext: OcrExtraction,
  opts: { mode: UploadMode; targetId: string | null; imageUrl: string },
): IngestResult {
  const decision = decideSpecial(ext, opts.mode);
  const warnings = [...decision.warnings];
  const readName = normalizeName(ext.name).name;

  return db.transaction(() => {
    let existing: Warlord | null;
    let name: string;
    let isSpecial: boolean;

    if (opts.targetId) {
      existing = db.getWarlord(opts.targetId);
      if (!existing) throw new IngestError("統合先に指定された武将が見つかりません");
      name = existing.name;
      isSpecial = existing.is_special;
      if (readName && readName !== name) warnings.push(`画像の武将名「${readName}」が統合先「${name}」と異なります`);
      if (opts.mode === "auto" && decision.is_special !== isSpecial && decision.reasons.length > 0) {
        warnings.push(`画像は${decision.is_special ? "特異" : "通常"}武将と判定されましたが、指定された統合先に保存しました`);
      }
    } else {
      if (!readName) {
        throw new IngestError("武将名を読み取れませんでした。「統合先の武将」を指定して再アップロードしてください");
      }
      name = readName;
      isSpecial = decision.is_special;
      existing = db.findWarlord(name, isSpecial);
    }

    const patch = extractionToPatch(ext);
    patch.gallery_images = [opts.imageUrl];
    patch.image_url = opts.imageUrl;

    const base = existing ? toInput(existing) : { ...emptyWarlordInput(), name, is_special: isSpecial };
    const { merged, warnings: mergeWarnings } = mergeWarlord(base, patch);
    warnings.push(...mergeWarnings);

    const counterpart = db.findWarlord(name, !isSpecial);
    const sanitized = sanitizeWeaponAwakening(merged, counterpart);
    warnings.push(...sanitized.warnings);

    const record = normalizeInput(sanitized.record);
    const warlord = existing ? db.updateWarlord(existing.id, record) : db.insertWarlord(record);
    return { warlord, merged: Boolean(existing), warnings };
  });
}

export { warlordLabel };
