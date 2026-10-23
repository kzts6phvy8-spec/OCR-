import type { Faction, OcrJob, UploadMode } from "../../core/types.ts";
import { ingestExtraction } from "../../core/ingest.ts";
import { warlordLabel } from "../../core/domain.ts";
import * as db from "./db.ts";
import { bgActive, loadSettings } from "./settings.ts";
import { callServer, type RemoteResult, type ServerCounts } from "./remote.ts";
import { buildGeminiBody, geminiHttpError, parseGeminiRestBody } from "./geminiShared.ts";
import { blobToBase64 } from "./images.ts";
import { analyzeWithRetry } from "./analyze.ts";
import { OcrError } from "./ocrCommon.ts";
import { shrinkForGallery } from "./images.ts";
import { nextDailyReset } from "./quota.ts";
import { isStalled, probeIfNeeded } from "./probe.ts";
import { artChecker } from "./visual.ts";
import type { OcrExtraction } from "../../core/ocrSchema.ts";

// 画像を解析するキュー。AI への問い合わせは 2 枚同時に進め、保存 (同じ武将への統合) は 1 件ずつ順番に行う。
// iPhone ではアプリを閉じる・画面を消すと処理が止まるため、処理中は画面消灯を防ぎ、戻ったら自動で再開する。
// 無料枠などの利用上限に達したら、失敗にせずキュー全体を一時停止して待つ。

/** 端末で直接解析する時に同時に AI へ送る枚数 */
export const CONCURRENCY = 3;
/** バックグラウンド解析でサーバーへ同時に送る枚数 (送るだけなので多めに) */
export const UPLOAD_CONCURRENCY = 4;
/** この版以降のサーバーは「すぐ解析を始めて」の合図 (kick) に対応 */
const KICK_MIN_VERSION = 2;
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
  /** バックグラウンド解析サーバーの状況 (最後に確認した時点) */
  server: (ServerCounts & { checkedAt: number }) | null;
  serverError: string;
}

let serverCounts: QueueState["server"] = null;
let serverError = "";
let serverVersion = 0;
/** 最後にサーバーから結果を受け取った時刻 (止まっているかの目安) */
let lastResultAt = 0;
export const getServerVersion = () => serverVersion;
export const getLastResultAt = () => lastResultAt;

function setServerCounts(res: Partial<ServerCounts>) {
  serverCounts = {
    pending: res.pending ?? 0,
    ready: res.ready ?? 0,
    lastRunAt: res.lastRunAt,
    lastOkAt: res.lastOkAt,
    limit: res.limit ?? null,
    lastError: res.lastError ?? null,
    checkedAt: Date.now(),
  };
}

export const getQueueState = (): QueueState => ({
  running: workers > 0,
  pausedUntil: pausedUntil > Date.now() ? pausedUntil : null,
  pauseReason,
  server: serverCounts,
  serverError,
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

/** バックグラウンド解析: 依頼をサーバーに預ける (送り直しに備えて、結果が来るまで画像は元の大きさのまま) */
async function sendToServer(job: OcrJob, image: Blob) {
  const settings = loadSettings();
  await callServer(settings, "enqueue", {
    id: job.id,
    model: settings.geminiModel,
    body: buildGeminiBody(await blobToBase64(image), job.mode),
  });
  await update(job, { status: "remote" });
  kickServer();
}

let kicking = false;
/**
 * 新しいサーバー (版 2 以降) に「すぐ解析を始めて」と合図する。1 分ごとの自動起動を待たずに始まる。
 * サーバーは解析が終わるまで応答しないので、返事は待たずに 1 つだけ送っておく。
 */
function kickServer() {
  const settings = loadSettings();
  if (kicking || serverVersion < KICK_MIN_VERSION || !bgActive(settings)) return;
  kicking = true;
  void callServer(settings, "kick")
    .catch(() => {})
    .finally(() => {
      kicking = false;
    });
}

/** 解析が終わった画像を保存用の大きさに縮めて容量を節約する */
async function shrinkStoredImage(imageId: string) {
  try {
    const blob = await db.getImage(imageId);
    if (blob) await db.putImage(await shrinkForGallery(blob), imageId);
  } catch {
    /* 縮小できなくても解析結果には影響しない */
  }
}

/** 読み取り結果を図鑑に保存する。同じ名前の武将がいれば立ち絵を見比べてから統合する */
function ingestJob(job: OcrJob, extraction: OcrExtraction) {
  return ingestLock(() =>
    ingestExtraction(db.repo, extraction, {
      mode: job.mode,
      targetId: job.target_id,
      imageId: job.image_id,
      faction: job.faction ?? "",
      sameArt: artChecker(job.image_id),
    }),
  );
}

/** 無料枠などの上限: キュー全体を少し休ませる (30 秒 → 最大 10 分。1 日の上限なら戻る時刻まで) */
function pauseForRateLimit(err: OcrError) {
  backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(30_000, backoffMs * 2));
  pausedUntil = err.dailyLimit ? nextDailyReset().getTime() + 60_000 : Date.now() + backoffMs;
  pauseReason = err.message;
}

async function processJob(job: OcrJob) {
  const startedAt = Date.now();
  let extraction: OcrExtraction | null = job.extraction ?? null;
  try {
    const image = await db.getImage(job.image_id);
    if (!image) throw new Error("画像が見つかりません");
    if (!extraction) {
      if (bgActive(loadSettings()) && !job.local) return await sendToServer(job, image);
      extraction = await analyzeWithRetry(image, job.mode, loadSettings());
    }
    const result = await ingestJob(job, extraction);
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
      extraction: null,
    });
  } catch (err) {
    if (err instanceof OcrError && err.rateLimited) {
      // 上限に達した: このジョブは (読み取り済みならその結果を残して) 待機に戻し、キュー全体を少し休ませる
      pauseForRateLimit(err);
      await update(job, { status: "queued", attempts: Math.max(0, job.attempts - 1), extraction });
      return;
    }
    if (lastHiddenAt >= startedAt || (extraction && err instanceof OcrError && err.retryable && job.attempts < 3)) {
      // アプリを離れたせいで止まった・立ち絵の確認が一時的に失敗した分は、失敗にせずやり直す
      await update(job, { status: "queued", attempts: Math.max(0, job.attempts - 1), extraction });
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
  const next = await db.nextQueuedJob();
  const limit = bgActive(loadSettings()) && !next?.local ? UPLOAD_CONCURRENCY : CONCURRENCY;
  if (workers >= limit) return;
  if (!(await db.nextQueuedJob())) return;
  await keepAwake();
  while (workers < limit) {
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

/** 起動時・アプリに戻った時: 中断されていたジョブを再開し、サーバーの結果を受け取る */
export async function resumeQueue() {
  void pollServer();
  if (workers > 0) return; // 処理中のジョブはそのまま続ける
  await db.requeueStaleJobs();
  void runQueue();
}

// ---------------- バックグラウンド解析の結果受け取り ----------------

let polling = false;

/** サーバーで解析が終わった結果を受け取り、図鑑に反映する */
export async function pollServer() {
  const settings = loadSettings();
  if (polling || !bgActive(settings)) return;
  const jobs = await db.listJobs();
  if (!jobs.some((j) => j.status === "remote")) return;
  polling = true;
  try {
    for (;;) {
      const res = await callServer<{ results: RemoteResult[]; version?: number }>(settings, "results", { limit: 30 });
      setServerCounts(res);
      if (res.results.length) lastResultAt = Date.now();
      if (res.version) serverVersion = res.version;
      serverError = "";
      if (res.results.length === 0) break;
      const received: string[] = [];
      for (const r of res.results) {
        received.push(r.id);
        const job = await db.getJob(r.id);
        if (!job || job.status !== "remote") continue; // 取り消し済みなど
        await applyServerResult(job, r, settings.geminiModel);
      }
      await callServer(settings, "ack", { ids: received });
      if (res.results.length < 30) {
        if (serverCounts) serverCounts = { ...serverCounts, ready: Math.max(0, serverCounts.ready - received.length) };
        break;
      }
    }
    if (serverCounts && serverCounts.pending > 0) kickServer();
    // 版 2 以前のサーバーは止まっている理由を返さないので、止まっていればアプリから上限を確かめる
    if (!serverCounts?.limit && serverVersion < 3 && isStalled(await db.listJobs(), lastResultAt)) {
      await probeIfNeeded(settings);
    }
  } catch (err) {
    serverError = err instanceof Error ? err.message : String(err);
  } finally {
    polling = false;
    notify();
  }
}

async function applyServerResult(job: OcrJob, r: RemoteResult, model: string) {
  let extraction: OcrExtraction | null = null;
  try {
    if (!r.ok) {
      let message = r.error ?? "";
      try {
        message = (JSON.parse(message) as { error?: { message?: string } }).error?.message ?? message;
      } catch {
        /* そのまま */
      }
      throw geminiHttpError(r.status, message, model);
    }
    extraction = parseGeminiRestBody(r.body ?? "");
    const result = await ingestJob(job, extraction);
    await shrinkStoredImage(job.image_id);
    await update(job, {
      status: "done",
      warlord_id: result.warlord.id,
      warlord_label: warlordLabel(result.warlord),
      merged: result.merged,
      warnings: result.warnings,
    });
  } catch (err) {
    if (extraction && err instanceof OcrError && (err.rateLimited || err.retryable)) {
      // 読み取りは済んで、立ち絵の確認だけが失敗した: 読み取り結果を残し、この端末で保存だけやり直す
      if (err.rateLimited) pauseForRateLimit(err);
      await update(job, { status: "queued", local: true, extraction });
      void runQueue();
      return;
    }
    if (err instanceof OcrError && err.retryable && job.attempts < 3) {
      // 応答の形が崩れていた・設定の調整が必要だった等: もう一度サーバーに送り直す
      await update(job, { status: "queued" });
      void runQueue();
      return;
    }
    await update(job, { status: "error", error: err instanceof Error ? err.message : String(err) });
  }
}

// アプリを開いている間は 1 分ごとに結果を確かめる。
// サーバーは確認のたびに Google ドライブのフォルダを読むので、短すぎるとドライブ側がエラー
// (「サービス エラー: ドライブ」) を返し、サーバーの解析まで止まってしまう。
if (typeof window !== "undefined") {
  setInterval(() => {
    if (!document.hidden) void pollServer();
  }, 60_000);
}

/** サーバーの状況だけを確認する (設定画面・キュー画面の表示用) */
export async function refreshServerStatus() {
  const settings = loadSettings();
  if (!bgActive(settings)) return;
  try {
    const res = await callServer<{ version?: number }>(settings, "status");
    setServerCounts(res);
    if (res.version) serverVersion = res.version;
    serverError = "";
  } catch (err) {
    serverError = err instanceof Error ? err.message : String(err);
  }
  notify();
}

// ---------------- キューから取り除く ----------------

/**
 * サーバーで解析待ちのまま止まっているジョブを、この端末で直接解析し直す。
 * サーバー側の依頼は取り消す (届かなくても、後から来た結果は取り消し済みとして捨てる)。
 */
export async function takeOverRemoteJobs() {
  const settings = loadSettings();
  const remote = (await db.listJobs()).filter((j) => j.status === "remote");
  if (remote.length === 0) return 0;
  try {
    await callServer(settings, "cancel", { ids: remote.map((j) => j.id) });
  } catch {
    /* サーバーに届かなくても続ける */
  }
  for (const job of remote) {
    await db.saveJob({ ...job, status: "queued", local: true, attempts: 0, updated_at: new Date().toISOString() });
  }
  notify();
  void runQueue();
  return remote.length;
}

/**
 * サーバーで解析待ちの依頼を取り消し、今の設定のモデルで送り直す。
 * 依頼にはモデルが書き込まれているので、モデルを切り替えた後は送り直さないと新しいモデルで解析されない。
 */
export async function resendRemoteJobs() {
  const settings = loadSettings();
  const remote = (await db.listJobs()).filter((j) => j.status === "remote");
  if (remote.length === 0 || !bgActive(settings)) return 0;
  await callServer(settings, "cancel", { ids: remote.map((j) => j.id) });
  for (const job of remote) {
    await db.saveJob({ ...job, status: "queued", local: false, attempts: 0, updated_at: new Date().toISOString() });
  }
  resumeNow();
  return remote.length;
}

/** 待機中・サーバーで解析待ち・失敗のジョブを取り除く (解析中のものは取り除けない) */
export async function removeJobs(ids: string[]) {
  const settings = loadSettings();
  const removable: OcrJob[] = [];
  for (const id of ids) {
    const job = await db.getJob(id);
    if (job && job.status !== "processing" && job.status !== "done") removable.push(job);
  }
  const remoteIds = removable.filter((j) => j.status === "remote").map((j) => j.id);
  if (remoteIds.length && bgActive(settings)) {
    try {
      await callServer(settings, "cancel", { ids: remoteIds });
    } catch {
      /* サーバーに届かなくても、結果が来た時に取り消し済みとして捨てる */
    }
  }
  await db.deleteJobs(removable.map((j) => j.id));
  await db.removeUnreferencedImages(removable.map((j) => j.image_id));
  notify();
  return removable.length;
}
