import { normalizeInput } from "../../core/domain.ts";
import { toInput } from "../../core/ingest.ts";
import * as db from "./db.ts";

// 同じスクショが 2 回登録された時 (同じ写真を選び直した・失敗を再試行した等) に、中身がまったく同じ画像を 1 枚にまとめる。
// 画像は保存のたびに別の ID になるので、ID ではなく中身 (SHA-256) で比べる。

const hashes = new Map<string, Promise<string | null>>();

function hashOf(imageId: string) {
  let p = hashes.get(imageId);
  if (!p) {
    p = (async () => {
      const blob = await db.getImage(imageId);
      if (!blob || typeof crypto === "undefined" || !crypto.subtle) return null;
      const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    })().catch(() => null);
    hashes.set(imageId, p);
  }
  return p;
}

/** 武将の画像から、中身が同じ画像を取り除く。取り除いた枚数を返す */
export async function dedupeWarlordImages(warlordId: string): Promise<number> {
  const w = await db.getWarlord(warlordId);
  if (!w || w.gallery_images.length < 2) return 0;
  const seen = new Set<string>();
  const keep: string[] = [];
  const removed: string[] = [];
  for (const id of w.gallery_images) {
    // 縮小し直した画像は中身が変わるので、作り直した指紋は使い回さない
    hashes.delete(id);
    const h = await hashOf(id);
    if (h && seen.has(h)) removed.push(id);
    else {
      if (h) seen.add(h);
      keep.push(id);
    }
  }
  if (removed.length === 0) return 0;
  const input = toInput(w);
  await db.updateWarlord(w.id, normalizeInput({ ...input, gallery_images: keep, image_url: keep.includes(input.image_url) ? input.image_url : keep[0] }));
  await db.deleteImagesNotInGallery(removed);
  return removed.length;
}

/** すべての武将の、中身が同じ画像を 1 枚にまとめる。{ まとめた武将の数, 取り除いた枚数 } */
export async function dedupeAllImages(): Promise<{ warlords: number; images: number }> {
  let warlords = 0;
  let images = 0;
  for (const w of await db.listWarlords()) {
    // 1 人で失敗しても (途中で消された等)、ほかの武将は続ける
    const n = await dedupeWarlordImages(w.id).catch(() => 0);
    if (n) {
      warlords++;
      images += n;
    }
  }
  return { warlords, images };
}

export interface CrossDuplicate {
  /** 同じ画像が入っている武将たちと、それぞれの中の画像 ID */
  entries: { warlordId: string; imageId: string }[];
  /** exact: 中身がまったく同じ / similar: 同じ名前の武将どうしで、立ち絵の指紋がほぼ同じ */
  kind: "exact" | "similar";
}

/**
 * 同じ画像なのに、別々の武将に登録されているものを探す (確かめる用。何も書き換えない)。
 * 中身がまったく同じ画像と、同じ名前の武将どうしで指紋がほぼ同じ画像 (撮り直し・縮め直し) を挙げる。
 */
export async function findCrossDuplicates(onProgress?: (done: number, total: number) => void): Promise<CrossDuplicate[]> {
  const warlords = await db.listWarlords();
  const entries = warlords.flatMap((w) => w.gallery_images.map((imageId) => ({ warlordId: w.id, imageId, name: w.name })));
  const byHash = new Map<string, { warlordId: string; imageId: string }[]>();
  for (const [i, e] of entries.entries()) {
    hashes.delete(e.imageId);
    const h = await hashOf(e.imageId);
    if (h) byHash.set(h, [...(byHash.get(h) ?? []), e]);
    if (i % 20 === 0) onProgress?.(i, entries.length);
  }
  const result: CrossDuplicate[] = [];
  const exactIds = new Set<string>();
  for (const list of byHash.values()) {
    if (new Set(list.map((e) => e.warlordId)).size < 2) continue;
    result.push({ kind: "exact", entries: list.map(({ warlordId, imageId }) => ({ warlordId, imageId })) });
    list.forEach((e) => exactIds.add(e.imageId));
  }
  // 同じ名前の武将どうしで、指紋がほぼ同じ画像 (中身は少し違うが、同じ画面のスクショ)
  const { signaturesOf } = await import("./visual.ts");
  const sigs = await signaturesOf(entries.map((e) => e.imageId));
  const { signatureSimilarity } = await import("./images.ts");
  const byName = new Map<string, typeof entries>();
  for (const e of entries) byName.set(e.name, [...(byName.get(e.name) ?? []), e]);
  for (const list of byName.values()) {
    if (new Set(list.map((e) => e.warlordId)).size < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a.warlordId === b.warlordId || exactIds.has(a.imageId) || exactIds.has(b.imageId)) continue;
        const sa = sigs.get(a.imageId);
        const sb = sigs.get(b.imageId);
        if (sa && sb && signatureSimilarity(sa, sb) >= 0.99) {
          result.push({ kind: "similar", entries: [a, b].map(({ warlordId, imageId }) => ({ warlordId, imageId })) });
        }
      }
    }
  }
  onProgress?.(entries.length, entries.length);
  return result;
}
