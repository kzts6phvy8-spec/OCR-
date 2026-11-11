import type { MeishoTalent, Warlord } from "../../core/types.ts";
import { extractionToPatch, normText, normalizeInput, resolveMeishoSlots } from "../../core/domain.ts";
import { toInput } from "../../core/ingest.ts";
import * as db from "./db.ts";

// 名将の名将修行の追加天賦を、その名将に入っている名将修行の画面 (画像ごとの読み取り結果) から決め直す。
// 丸の位置の読み違いで同じ丸に 2 つ入り、別の丸が空いたままになるのを防ぐ。

/** 1 人分を決め直して保存する (変わらなければ保存しない)。決め直した武将を返す */
export async function recomputeMeishoTalents(w: Warlord): Promise<Warlord> {
  if (!w.meisho_images?.length) return w;
  const reads: MeishoTalent[] = [];
  for (const id of w.meisho_images) {
    const ext = await db.getExtraction(id).catch(() => null);
    const t = ext ? extractionToPatch(ext).meisho_talents?.[0] : undefined;
    if (t) reads.push(t);
  }
  const resolved = resolveMeishoSlots(reads);
  // 画像の無い前の読み取り (この仕組みの前に入った分) は、空いている丸にだけ残す
  for (const t of w.meisho_talents ?? []) {
    if (!resolved.some((r) => r.rank === t.rank && r.slot === t.slot) && !reads.some((r) => normText(r.effect) === normText(t.effect))) resolved.push(t);
  }
  const next = resolveMeishoSlots(resolved);
  if (JSON.stringify(next) === JSON.stringify(w.meisho_talents ?? [])) return w;
  return db.updateWarlord(w.id, normalizeInput({ ...toInput(w), meisho_talents: next }));
}

/** 全員分を決め直す (起動時) */
export async function recomputeAllMeishoTalents(): Promise<number> {
  let n = 0;
  for (const w of await db.listWarlords()) {
    if (!w.meisho_images?.length) continue;
    if ((await recomputeMeishoTalents(w)) !== w) n++;
  }
  return n;
}
