import { randomUUID } from "node:crypto";
import path from "node:path";
import type { OcrJob, UploadMode } from "../shared/types.ts";
import { config } from "./config.ts";
import * as db from "./db.ts";
import { ingestExtraction, warlordLabel } from "./ingest.ts";
import { analyzeWithRetry } from "./ocr.ts";

// アップロードされた画像を 1 枚ずつ順番に解析するバックグラウンドキュー。
// 同じ武将への統合が競合しないよう、意図的に直列実行にしている。

let running = false;

export function enqueue(files: { fileName: string; storedName: string }[], mode: UploadMode, targetId: string | null) {
  const now = new Date().toISOString();
  const jobs: OcrJob[] = files.map((f) => ({
    id: randomUUID(),
    file_name: f.fileName,
    image_url: `/uploads/${f.storedName}`,
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
  for (const job of jobs) db.saveJob(job);
  void runWorker();
  return jobs;
}

export function retryJob(id: string): OcrJob | null {
  const job = db.getJob(id);
  if (!job || job.status !== "error") return null;
  const next: OcrJob = { ...job, status: "queued", error: null, warnings: [], updated_at: new Date().toISOString() };
  db.saveJob(next);
  void runWorker();
  return next;
}

function update(job: OcrJob, patch: Partial<OcrJob>): OcrJob {
  const next = { ...job, ...patch, updated_at: new Date().toISOString() };
  db.saveJob(next);
  return next;
}

export async function runWorker() {
  if (running) return;
  running = true;
  try {
    for (let job = db.nextQueuedJob(); job; job = db.nextQueuedJob()) {
      job = update(job, { status: "processing", attempts: job.attempts + 1 });
      try {
        const filePath = path.join(config.uploadDir, path.basename(job.image_url));
        const extraction = await analyzeWithRetry(filePath, job.mode);
        const result = ingestExtraction(extraction, {
          mode: job.mode,
          targetId: job.target_id,
          imageUrl: job.image_url,
        });
        update(job, {
          status: "done",
          warlord_id: result.warlord.id,
          warlord_label: warlordLabel(result.warlord),
          merged: result.merged,
          warnings: result.warnings,
        });
      } catch (err) {
        console.error(`[ocr] ${job.file_name}:`, err);
        update(job, { status: "error", error: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    running = false;
  }
}
