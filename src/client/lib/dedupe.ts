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
    const n = await dedupeWarlordImages(w.id);
    if (n) {
      warlords++;
      images += n;
    }
  }
  return { warlords, images };
}
