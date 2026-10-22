import { AWAKENING_PRIORITIES } from "../../core/types.ts";
import type { ExportPayload, Faction, OcrJob, UploadMode, Warlord, WarlordInput } from "../../core/types.ts";
import { warlordsToText } from "../../core/text.ts";
import { normalizeInput } from "../../core/domain.ts";
import { toInput } from "../../core/ingest.ts";
import * as db from "./db.ts";
import { blobToDataUrl, compressImage, dataUrlToBlob } from "./images.ts";
import * as queue from "./queue.ts";

// 画面から使う操作。サーバーは無く、すべて端末内で完結する。

export const api = {
  warlords: () => db.listWarlords(),

  async createWarlord(input: Partial<WarlordInput>): Promise<Warlord> {
    const record = normalizeInput(input);
    if (!record.name) throw new Error("武将名は必須です");
    return db.insertWarlord(record);
  },

  async updateWarlord(id: string, input: Partial<WarlordInput>): Promise<Warlord> {
    const current = await db.getWarlord(id);
    if (!current) throw new Error("武将が見つかりません");
    const record = normalizeInput({ ...toInput(current), ...input });
    if (!record.name) throw new Error("武将名は必須です");
    const updated = await db.updateWarlord(id, record);
    await db.removeUnreferencedImages(current.gallery_images.filter((g) => !updated.gallery_images.includes(g)));
    return updated;
  },

  /**
   * 優先度が無い・古い表記 (極高 など) の武将に、覚醒スキルの発動条件から新しい表記の優先度を入れる。
   * 起動時に呼ぶ。直した件数と、条件が一覧に無くて直せなかった件数を返す。
   */
  async fillPriorities(): Promise<{ updated: number; unmatched: number }> {
    let updated = 0;
    let unmatched = 0;
    for (const w of await db.listWarlords()) {
      const record = normalizeInput(toInput(w));
      if (record.awakening_priority !== w.awakening_priority) {
        await db.updateWarlord(w.id, record);
        updated++;
      } else if (record.has_awakening && !AWAKENING_PRIORITIES.includes(record.awakening_priority)) unmatched++;
    }
    return { updated, unmatched };
  },

  async deleteWarlord(id: string) {
    await api.deleteWarlords([id]);
  },

  async deleteWarlords(ids: string[]) {
    const images: string[] = [];
    for (const id of ids) {
      const current = await db.getWarlord(id);
      if (!current) continue;
      await db.deleteWarlord(id);
      images.push(...current.gallery_images);
    }
    await db.removeUnreferencedImages(images);
  },

  /** 武将・画像・解析履歴をすべて消す (設定と API キーは残る) */
  async deleteEverything() {
    await db.deleteEverything();
    queue.notifyQueueChange();
  },

  jobs: () => db.listJobs(),
  retryJob: (id: string) => queue.retryJob(id),
  removeJobs: (ids: string[]) => queue.removeJobs(ids),
  takeOverRemoteJobs: () => queue.takeOverRemoteJobs(),
  resendRemoteJobs: () => queue.resendRemoteJobs(),
  async retryAllFailed() {
    const failed = (await db.listJobs()).filter((j) => j.status === "error").map((j) => j.id);
    await queue.retryJobs(failed);
    return failed.length;
  },

  async clearFinishedJobs() {
    const failedImages = await db.deleteFinishedJobs();
    await db.removeUnreferencedImages(failedImages);
    queue.notifyQueueChange();
  },

  /** 画像を縮小して端末内に保存し、解析キューに追加する */
  async upload(
    files: File[],
    opts: { mode: UploadMode; targetId: string | null; faction: Faction | "" },
    onProgress: (ratio: number) => void,
  ): Promise<OcrJob[]> {
    const stored: { fileName: string; imageId: string }[] = [];
    for (const [i, file] of files.entries()) {
      const blob = await compressImage(file);
      stored.push({ fileName: file.name || `画像${i + 1}`, imageId: await db.putImage(blob) });
      onProgress((i + 1) / files.length);
    }
    return queue.enqueue(stored, opts.mode, opts.targetId, opts.faction);
  },

  async exportText(): Promise<Blob> {
    const list = (await db.listWarlords()).sort((a, b) => a.name.localeCompare(b.name, "ja") || Number(a.is_special) - Number(b.is_special));
    return new Blob([warlordsToText(list)], { type: "text/plain;charset=utf-8" });
  },

  async exportData(includeImages: boolean): Promise<Blob> {
    const warlords = await db.listWarlords();
    const payload: ExportPayload = { app: "sengoku-fubu-warlord-db", version: 2, exported_at: new Date().toISOString(), warlords };
    if (includeImages) {
      payload.images = {};
      for (const id of new Set(warlords.flatMap((w) => w.gallery_images))) {
        const blob = await db.getImage(id);
        if (blob) payload.images[id] = await blobToDataUrl(blob);
      }
    }
    return new Blob([JSON.stringify(payload)], { type: "application/json" });
  },

  async importData(payload: unknown, mode: "merge" | "replace") {
    const body = payload as Partial<ExportPayload> | Warlord[];
    const list = Array.isArray(body) ? body : body?.warlords;
    if (!Array.isArray(list)) throw new Error("JSON の形式が正しくありません (warlords 配列が必要です)");
    const images = Array.isArray(body) ? undefined : body.images;

    if (images) for (const [id, url] of Object.entries(images)) await db.putImage(await dataUrlToBlob(url), id);
    if (mode === "replace") await db.deleteAllWarlords();

    let created = 0;
    let updated = 0;
    const errors: string[] = [];
    for (const [i, raw] of list.entries()) {
      const input = normalizeInput(raw ?? {});
      if (!input.name) {
        errors.push(`${i + 1} 件目: 武将名がありません`);
        continue;
      }
      const existing = await db.findWarlord(input.name, input.is_special);
      if (existing) {
        await db.updateWarlord(existing.id, input);
        updated++;
      } else {
        const id = typeof raw?.id === "string" && !(await db.getWarlord(raw.id)) ? raw.id : undefined;
        await db.insertWarlord(input, { id, created_at: typeof raw?.created_at === "string" ? raw.created_at : undefined });
        created++;
      }
    }
    return { created, updated, errors };
  },
};
