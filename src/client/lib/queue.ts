import type { Faction, OcrJob, UploadMode } from "../../core/types.ts";
import { ingestExtraction } from "../../core/ingest.ts";
import { warlordLabel } from "../../core/domain.ts";
import * as db from "./db.ts";
import { loadSettings } from "./settings.ts";
import { analyzeWithRetry } from "./analyze.ts";

// 画像を 1 枚ずつ順番に解析するキュー。同じ武将への統合が競合しないよう直列実行。
// iPhone ではアプリを閉じる・画面を消すと処理が止まるため、処理中は画面消灯を防ぐ。

let running = false;
/** 処理中にアプリが裏に回った (iPhone では通信が止まる) か */
let wentHidden = false;
const listeners = new Set<() => void>();

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (running) wentHidden = true;
    } else {
      // アプリに戻ってきたら、中断していた解析を自動で再開する
      void resumeQueue();
    }
  });
}

export function onQueueChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const notify = () => listeners.forEach((fn) => fn());
export const notifyQueueChange = notify;

export async function enqueue(
  imageIds: { fileName: string; imageId: string }[],
  mode: UploadMode,
  targetId: string | null,
  faction: Faction | "",
) {
  const now = new Date().toISOString();
  const jobs: OcrJob[] = imageIds.map((f) => ({
    id: crypto.randomUUID(),
    file_name: f.fileName,
    image_id: f.imageId,
    mode,
    faction,
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
      if (typeof document !== "undefined" && document.hidden) break; // 裏にいる間は始めない
      lock ??= await keepAwake();
      wentHidden = false;
      job = await update(job, { status: "processing", attempts: job.attempts + 1 });
      try {
        const image = await db.getImage(job.image_id);
        if (!image) throw new Error("画像が見つかりません");
        const extraction = await analyzeWithRetry(image, job.mode, loadSettings());
        const result = await ingestExtraction(db.repo, extraction, {
          mode: job.mode,
          targetId: job.target_id,
          imageId: job.image_id,
          faction: job.faction ?? "",
        });
        await update(job, {
          status: "done",
          warlord_id: result.warlord.id,
          warlord_label: warlordLabel(result.warlord),
          merged: result.merged,
          warnings: result.warnings,
        });
      } catch (err) {
        if (wentHidden) {
          // アプリを離れたせいで止まった分は失敗にせず、戻ってきた時にやり直す
          await update(job, { status: "queued", attempts: job.attempts - 1 });
          break;
        }
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
  if (running) return; // 処理中のジョブはそのまま続ける
  await db.requeueStaleJobs();
  void runQueue();
}
