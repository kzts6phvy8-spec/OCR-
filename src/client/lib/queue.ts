import type { Faction, OcrJob, UploadMode } from "../../core/types.ts";
import { ingestExtraction } from "../../core/ingest.ts";
import { warlordLabel } from "../../core/domain.ts";
import * as db from "./db.ts";
import { loadSettings } from "./settings.ts";
import { analyzeWithRetry } from "./analyze.ts";
import { OcrError } from "./ocrCommon.ts";
import { shrinkForGallery } from "./images.ts";

// 画像を解析するキュー。AI への問い合わせは 2 枚同時に進め、保存 (同じ武将への統合) は 1 件ずつ順番に行う。
// iPhone ではアプリを閉じる・画面を消すと処理が止まるため、処理中は画面消灯を防ぎ、戻ったら自動で再開する。
// 無料枠などの利用上限に達したら、失敗にせずキュー全体を一時停止して待つ。

export const CONCURRENCY = 2;
const MAX_BACKOFF_MS = 10 * 60_000;

let workers = 0;
/** 最後にアプリが裏に回った時刻 (その間に通信が止まったジョブは失敗にしない) */
let lastHiddenAt = 0;
let backoffMs = 0;
let pausedUntil = 0;
let pauseReason = "";
const listeners = new Set<() => void>();

export interface QueueState {
  running: boolean;
  /** 利用上限で一時停止中なら再開予定時刻 */
  pausedUntil: number | null;
  pauseReason: string;
}

export const getQueueState = (): QueueState => ({
  running: workers > 0,
  pausedUntil: pausedUntil > Date.now() ? pausedUntil : null,
  pauseReason,
});

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (workers > 0) lastHiddenAt = Date.now();
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 複数の作業を 1 つずつ順番に実行するための鍵 */
function serial() {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };
}
const claimLock = serial();
const ingestLock = serial();

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
    started_at: null,
    created_at: now,
    updated_at: now,
  }));
  for (const job of jobs) await db.saveJob(job);
  notify();
  void runQueue();
  return jobs;
}

export async function retryJobs(ids: string[]) {
  for (const id of ids) {
    const job = await db.getJob(id);
    if (!job || job.status !== "error") continue;
    await db.saveJob({ ...job, status: "queued", error: null, warnings: [], updated_at: new Date().toISOString() });
  }
  notify();
  void runQueue();
}

export const retryJob = (id: string) => retryJobs([id]);

/** 一時停止を解除してすぐ再開する */
export function resumeNow() {
  pausedUntil = 0;
  backoffMs = 0;
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
let wakeLock: WakeLock | null = null;
async function keepAwake() {
  if (wakeLock) return;
  try {
    const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<WakeLock> } };
    wakeLock = (await nav.wakeLock?.request("screen")) ?? null;
  } catch {
    wakeLock = null;
  }
}

async function processJob(job: OcrJob) {
  const startedAt = Date.now();
  try {
    const image = await db.getImage(job.image_id);
    if (!image) throw new Error("画像が見つかりません");
    const extraction = await analyzeWithRetry(image, job.mode, loadSettings());
    const result = await ingestLock(() =>
      ingestExtraction(db.repo, extraction, {
        mode: job.mode,
        targetId: job.target_id,
        imageId: job.image_id,
        faction: job.faction ?? "",
      }),
    );
    // 解析が終わった画像は保存用の大きさに縮めて容量を節約する
    try {
      await db.putImage(await shrinkForGallery(image), job.image_id);
    } catch {
      /* 縮小できなくても解析結果には影響しない */
    }
    backoffMs = 0;
    await update(job, {
      status: "done",
      warlord_id: result.warlord.id,
      warlord_label: warlordLabel(result.warlord),
      merged: result.merged,
      warnings: result.warnings,
    });
  } catch (err) {
    if (err instanceof OcrError && err.rateLimited) {
      // 上限に達した: このジョブは待機に戻し、キュー全体を少し休ませる (30 秒 → 最大 10 分)
      backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(30_000, backoffMs * 2));
      pausedUntil = Date.now() + backoffMs;
      pauseReason = err.message;
      await update(job, { status: "queued", attempts: Math.max(0, job.attempts - 1) });
      return;
    }
    if (lastHiddenAt >= startedAt) {
      // アプリを離れたせいで止まった分は失敗にせず、戻ってきた時にやり直す
      await update(job, { status: "queued", attempts: Math.max(0, job.attempts - 1) });
      return;
    }
    console.error(`[ocr] ${job.file_name}:`, err);
    await update(job, { status: "error", error: err instanceof Error ? err.message : String(err) });
  }
}

async function worker() {
  for (;;) {
    if (typeof document !== "undefined" && document.hidden) return; // 裏にいる間は始めない
    while (pausedUntil > Date.now()) {
      await sleep(Math.min(1000, pausedUntil - Date.now()));
      if (typeof document !== "undefined" && document.hidden) return;
    }
    // 次のジョブを取り出して「解析中」にするまでを 1 人ずつ行い、同じジョブを二重に取らないようにする
    const job = await claimLock(async () => {
      const next = await db.nextQueuedJob();
      if (!next) return null;
      return update(next, { status: "processing", attempts: next.attempts + 1, started_at: new Date().toISOString() });
    });
    if (!job) return;
    await processJob(job);
  }
}

export async function runQueue() {
  if (workers >= CONCURRENCY) return;
  if (!(await db.nextQueuedJob())) return;
  await keepAwake();
  while (workers < CONCURRENCY) {
    workers++;
    notify();
    void worker().finally(async () => {
      workers--;
      if (workers === 0) {
        await wakeLock?.release().catch(() => {});
        wakeLock = null;
      }
      notify();
    });
  }
}

/** 起動時・アプリに戻った時: 中断されていたジョブを再開 */
export async function resumeQueue() {
  if (workers > 0) return; // 処理中のジョブはそのまま続ける
  await db.requeueStaleJobs();
  void runQueue();
}
