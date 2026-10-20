import type { OcrJob, UploadMode } from "../../core/types.ts";
import { ingestExtraction } from "../../core/ingest.ts";
import { warlordLabel } from "../../core/domain.ts";
import * as db from "./db.ts";
import { loadSettings } from "./settings.ts";

// 画像を 1 枚ずつ順番に解析するキュー。同じ武将への統合が競合しないよう直列実行。
// iPhone ではアプリを閉じる・画面を消すと処理が止まるため、処理中は画面消灯を防ぐ。

let running = false;
const listeners = new Set<() => void>();

export function onQueueChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const notify = () => listeners.forEach((fn) => fn());
export const notifyQueueChange = notify;

export async function enqueue(imageIds: { fileName: string; imageId: string }[], mode: UploadMode, targetId: string | null) {
  const now = new Date().toISOString();
  const jobs: OcrJob[] = imageIds.map((f) => ({
    id: crypto.randomUUID(),
    file_name: f.fileName,
    image_id: f.imageId,
    mode,
    target_id: targetId,
    status: "queued",
    error: null,
    warlord_id: null,
    warlord_label: null,
    merged: false,
    warnings: [],
    attempts: 0,
    created_at: now,
    updated_at: now,
  }));
  for (const job of jobs) await db.saveJob(job);
  notify();
  void runQueue();
  return jobs;
}

export async function retryJob(id: string) {
  const job = await db.getJob(id);
  if (!job || job.status !== "error") return;
  await db.saveJob({ ...job, status: "queued", error: null, warnings: [], updated_at: new Date().toISOString() });
  notify();
  void runQueue();
}

async function update(job: OcrJob, patch: Partial<OcrJob>): Promise<OcrJob> {
  const next = { ...job, ...patch, updated_at: new Date().toISOString() };
  await db.saveJob(next);
  notify();
  return next;
}

type WakeLock = { release(): Promise<void> };
async function keepAwake(): Promise<WakeLock | null> {
  try {
    const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<WakeLock> } };
    return (await nav.wakeLock?.request("screen")) ?? null;
  } catch {
    return null;
  }
}

export async function runQueue() {
  if (running) return;
  running = true;
  let lock: WakeLock | null = null;
  try {
    for (let job = await db.nextQueuedJob(); job; job = await db.nextQueuedJob()) {
      lock ??= await keepAwake();
      job = await update(job, { status: "processing", attempts: job.attempts + 1 });
      try {
        const image = await db.getImage(job.image_id);
        if (!image) throw new Error("画像が見つかりません");
        // AI 通信部分は大きいので、解析を始める時だけ読み込む
        const { analyzeWithRetry } = await import("./ocr.ts");
        const extraction = await analyzeWithRetry(image, job.mode, loadSettings());
        const result = await ingestExtraction(db.repo, extraction, {
          mode: job.mode,
          targetId: job.target_id,
          imageId: job.image_id,
        });
        await update(job, {
          status: "done",
          warlord_id: result.warlord.id,
          warlord_label: warlordLabel(result.warlord),
          merged: result.merged,
          warnings: result.warnings,
        });
      } catch (err) {
        console.error(`[ocr] ${job.file_name}:`, err);
        await update(job, { status: "error", error: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    running = false;
    await lock?.release().catch(() => {});
  }
}

/** 起動時: 中断されていたジョブを再開 */
export async function resumeQueue() {
  await db.requeueStaleJobs();
  void runQueue();
}
