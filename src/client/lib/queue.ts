import type { Faction, OcrJob, Talent, UploadMode, Warlord } from "../../core/types.ts";
import { differsByOneChar, ingestExtraction } from "../../core/ingest.ts";
import { emptyWarlordInput, normalizeInput, warlordLabel } from "../../core/domain.ts";
import * as db from "./db.ts";
import { bgActive, loadSettings } from "./settings.ts";
import { ServerError, callServer, type RemoteResult, type ServerCounts } from "./remote.ts";
import { buildGeminiBody, buildGeminiPartsBody, geminiHttpError, geminiRestText, parseGeminiRestBody } from "./geminiShared.ts";
import { blobToBase64 } from "./images.ts";
import { analyzeWithRetry } from "./analyze.ts";
import { OcrError } from "./ocrCommon.ts";
import { shrinkForGallery } from "./images.ts";
import { nextDailyReset } from "./quota.ts";
import { isStalled, probeIfNeeded } from "./probe.ts";
import {
  ART_CHECK_SCHEMA,
  MEISHO_CONFIRM_SCHEMA,
  MEISHO_SHORTLIST_SCHEMA,
  NeedServerArtCheck,
  artChecker,
  buildArtCheckRequest,
  interpretAnswer,
  buildMeishoConfirmRequest,
  buildMeishoShortlistRequest,
  identifyMeishoByArt,
  matchKnownTraining,
  parseMeishoConfirm,
  parseMeishoShortlist,
  type Part,
} from "./visual.ts";
import { logError } from "./errorLog.ts";
import { dedupeWarlordImages } from "./dedupe.ts";
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
  /** サーバーの解析結果を図鑑に反映している途中なら、その進み具合 */
  receiving: { done: number; total: number } | null;
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
  receiving,
});

let receiving: QueueState["receiving"] = null;

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
// 画面への知らせはまとめて送る (結果を何十件も続けて保存する時に、1 件ごとに画面全体を作り直さないように)
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
const notify = () => {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    listeners.forEach((fn) => fn());
  }, 300);
};
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
/**
 * 武将の読み書き (手での編集・まとめる・起動時の手直しなど) を、解析結果の保存と重ならないように 1 つずつ行う。
 * 重なると、片方が読んだ古い内容で上書きして、もう片方の変更が消えてしまう。
 */
export const exclusive = <T>(fn: () => Promise<T>) => ingestLock(fn);

export async function enqueue(
  imageIds: { fileName: string; imageId: string }[],
  mode: UploadMode,
  targetId: string | null,
  faction: Faction | "",
  /** 登録済みの画像をもう一度解析する時 (失敗しても画像は消さない) */
  keepImage = false,
  opts: {
    /** 前の読み取り結果があれば使い回す (AI に読み直させない) */
    reuse?: boolean;
    /** この武将たちには統合しない */
    excludeIds?: string[];
    /** 再解析の回 (最初の保存の前に、統合先の読み取った内容を空にする) */
    resetBatch?: string;
    /** 天賦だけを読み直す */
    talentsOnly?: boolean;
  } = {},
) {
  const now = new Date().toISOString();
  const saved = new Map<string, OcrExtraction>();
  if (opts.reuse) {
    for (const f of imageIds) {
      const ext = await db.getExtraction(f.imageId).catch(() => null);
      if (ext) saved.set(f.imageId, ext);
    }
  }
  const jobs: OcrJob[] = imageIds.map((f) => ({
    ...(keepImage ? { keep_image: true } : {}),
    ...(opts.excludeIds?.length ? { exclude_ids: opts.excludeIds } : {}),
    ...(opts.resetBatch ? { reset_batch: opts.resetBatch } : {}),
    ...(opts.talentsOnly ? { talents_only: true } : {}),
    // 読み取り結果があれば、この端末で保存だけ行う
    ...(saved.has(f.imageId) ? { extraction: saved.get(f.imageId), local: true } : {}),
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

/** 失敗したジョブをやり直す。targetId を渡すと、その武将に統合する (読み取り済みなら読み取りは繰り返さない) */
export async function retryJobs(ids: string[], targetId?: string, adoptSpecial = false) {
  for (const id of ids) {
    const job = await db.getJob(id);
    if (!job || job.status !== "error") continue;
    await db.saveJob({
      ...job,
      status: "queued",
      error: null,
      warnings: [],
      attempts: 0,
      ...(targetId ? { target_id: targetId } : {}),
      adopt_special: adoptSpecial,
      updated_at: new Date().toISOString(),
    });
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

/** 保存されている今のジョブに変更を重ねて保存する (古い写しで上書きしないため。api からも使う) */
export async function patchJob(id: string, patch: Partial<OcrJob>) {
  const current = await db.getJob(id);
  if (current) await update(current, patch);
}

async function update(job: OcrJob, patch: Partial<OcrJob>): Promise<OcrJob> {
  // 手元の古い写しではなく、保存されている今のジョブに変更を重ねる
  // (処理中に「まとめる」で統合先が付け替えられた等を、古い値で戻さないため)
  const current = await db.getJob(job.id);
  if (!current) return { ...job, ...patch }; // 取り除かれたジョブは保存し直さない
  const next = { ...current, ...patch, updated_at: new Date().toISOString() };
  if (patch.status === "error" && patch.error) logError("解析", `${job.file_name}: ${patch.error}`);
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
  await update(job, { status: "remote", server_req: null, meisho_stage: null, art_pending: null });
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
  void callServer<ServerCounts>(settings, "kick")
    .then((res) => {
      kicking = false;
      // サーバーは解析し終えてから返事をするので、結果ができていればすぐ受け取りに行く (1 分ごとの確認を待たない)
      if (res?.ready > 0 && (typeof document === "undefined" || !document.hidden)) void pollServer();
    })
    .catch(() => {
      kicking = false;
    });
}

let shrinkChain: Promise<void> = Promise.resolve();

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
function ingestJob(snapshot: OcrJob, extraction: OcrExtraction) {
  return ingestLock(async () => {
    // 順番を待つ間に取り除かれた・統合先が付け替えられたかもしれないので、今の状態で保存する
    const job = await db.getJob(snapshot.id);
    if (!job || (job.status !== "processing" && job.status !== "remote")) throw new JobCancelled();
    // 再解析: この回で最初に保存する画像の前に、統合先の読み取った内容を空にする (名前・通常/特異・勢力・シーズン・印・画像は残す)
    if (job.reset_batch && job.target_id) {
      const target = await db.getWarlord(job.target_id);
      if (target && target.reset_batch !== job.reset_batch) {
        await db.updateWarlord(
          target.id,
          normalizeInput({
            ...emptyWarlordInput(),
            name: target.name,
            is_special: target.is_special,
            faction: target.faction,
            oni_season: target.oni_season,
            no_synergy: target.no_synergy,
            is_meisho: target.is_meisho,
            meisho_manual: target.meisho_manual,
            // 名将修行の画面は登録画像に残さないので、読み取った追加天賦は作り直しで消さない
            meisho_talents: target.meisho_talents,
            meisho_images: target.meisho_images,
            gallery_images: target.gallery_images,
            image_url: target.image_url,
            reset_batch: job.reset_batch,
          }),
        );
      }
    }
    return ingestExtraction(db.repo, extraction, {
      mode: job.mode,
      targetId: job.target_id,
      adoptSpecial: job.adopt_special,
      imageId: job.image_id,
      faction: job.faction ?? "",
      // バックグラウンド解析がオンなら、立ち絵の確認で AI に尋ねる時もサーバーに任せる
      sameArt: artChecker(job.image_id, extraction.screen_types, bgActive(loadSettings()) ? { answers: job.art_answers ?? {} } : undefined),
      excludeIds: job.exclude_ids,
      // 名将修行の画面: 登録済みの名将 (名将の印がある武将) の立ち絵と見比べて誰かを決める
      identifyMeisho: async () => {
        // まず、すでに名将に振り分けた名将修行の画面と見比べる (同じ武将ならカードの絵がほぼ同じ。AI を使わない)
        const all = (await db.listWarlords()).filter((w) => !(job.exclude_ids ?? []).includes(w.id));
        const known = await matchKnownTraining(job.image_id, all.filter((w) => w.meisho_images?.length));
        if (known) return known;
        // バックグラウンド解析がオンなら、AI での見分けはサーバーに任せる (アプリを閉じていても進む)
        if (bgActive(loadSettings())) throw new NeedServerIdentify();
        return identifyMeishoByArt(job.image_id, await meishoCandidates(job));
      },
      similarNames: async (name) => {
        // 名前だけを索引から読む (全武将の中身を毎回読むと遅い)
        const names = (await db.listNames()).filter((n) => differsByOneChar(n, name));
        return (await Promise.all(names.map((n) => db.findByName(n)))).flat();
      },
    });
  });
}

/** 保存を待つ間に、ジョブが取り除かれていた */
class JobCancelled extends Error {}

/** 無料枠などの上限: キュー全体を少し休ませる (30 秒 → 最大 10 分。1 日の上限なら戻る時刻まで) */
function pauseForRateLimit(err: OcrError) {
  backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(30_000, backoffMs * 2));
  pausedUntil = err.dailyLimit ? nextDailyReset().getTime() + 60_000 : Date.now() + backoffMs;
  pauseReason = err.message;
}

// ---------------- 名将修行の画面の見分け (サーバーに任せる) ----------------

/** AI での見分けをサーバーに任せる合図 (保存の途中で投げ、ジョブをサーバーに預け直す) */
class NeedServerIdentify extends Error {}

/** 名将修行の画面の持ち主の候補: 名将の印がある武将と、名将一覧に名前があるのにまだ印を付けられていない武将 */
async function meishoCandidates(job: OcrJob): Promise<Warlord[]> {
  const all = (await db.listWarlords()).filter((w) => !(job.exclude_ids ?? []).includes(w.id));
  const { matchMeishoRoster } = await import("../../core/meisho.ts");
  const unsure = matchMeishoRoster(all)
    .filter((m) => m.decided.length === 0)
    .flatMap((m) => m.candidates)
    .filter((w) => !w.meisho_manual);
  return [...new Set([...all.filter((w) => w.is_meisho), ...unsure])];
}

const MEISHO_FAIL = "名将修行の画面の立ち絵から、どの名将か見分けられませんでした。下の「どの名将か選ぶ」で選んでください (その名将の名将修行に入れるだけで、武将をまとめるわけではありません)";

async function meishoFail(job: OcrJob, extraction: OcrExtraction, message = MEISHO_FAIL) {
  await update(job, { status: "error", error: message, extraction, local: true, meisho_stage: null, meisho_ids: null, server_req: null });
}

/** 見分けの依頼をサーバーに預ける (サーバー側の名前は、段階ごとに別にして取り違えないようにする) */
async function sendMeishoRequest(job: OcrJob, extraction: OcrExtraction, stage: 1 | 2, parts: Part[], ids: string[]) {
  const settings = loadSettings();
  const schema = stage === 1 ? MEISHO_SHORTLIST_SCHEMA : MEISHO_CONFIRM_SCHEMA;
  const req = `${job.id}~m${stage}-${Date.now().toString(36)}`;
  await callServer(settings, "enqueue", { id: req, model: settings.geminiModel, body: buildGeminiPartsBody(parts, schema, 1024) });
  await update(job, { status: "remote", extraction, local: true, meisho_stage: stage, meisho_ids: ids, server_req: req, art_pending: null });
  kickServer();
}

/** 見分けの 1 回目をサーバーに預ける (候補が 3 人以下なら 2 回目から) */
async function startServerIdentify(job: OcrJob, extraction: OcrExtraction) {
  const candidates = await meishoCandidates(job);
  const first = await buildMeishoShortlistRequest(job.image_id, candidates);
  if (!first) return meishoFail(job, extraction);
  if (first.parts) return sendMeishoRequest(job, extraction, 1, first.parts, first.ids);
  const second = await buildMeishoConfirmRequest(job.image_id, candidates.filter((w) => first.ids.includes(w.id)));
  if (!second) return meishoFail(job, extraction);
  return sendMeishoRequest(job, extraction, 2, second.parts, second.ids);
}

/** サーバーから見分けの答えが届いた */
async function applyMeishoAnswer(job: OcrJob, text: string) {
  const extraction = job.extraction;
  if (!extraction) throw new Error("読み取り結果がありません");
  const ids = job.meisho_ids ?? [];
  if (job.meisho_stage === 1) {
    const shortIds = parseMeishoShortlist(text, ids);
    const shortlist = (await Promise.all(shortIds.map((id) => db.getWarlord(id)))).filter((w): w is Warlord => Boolean(w));
    if (shortlist.length === 0) return meishoFail(job, extraction);
    const second = await buildMeishoConfirmRequest(job.image_id, shortlist);
    if (!second) return meishoFail(job, extraction);
    return sendMeishoRequest(job, extraction, 2, second.parts, second.ids);
  }
  const id = parseMeishoConfirm(text, ids);
  const found = id ? await db.getWarlord(id) : null;
  if (!found) return meishoFail(job, extraction);
  // 見分けた武将を統合先にして保存する
  const fresh = await update(job, { target_id: found.id });
  const result = await ingestJob(fresh, extraction);
  await update(fresh, {
    status: "done",
    warlord_id: result.warlord.id,
    warlord_label: warlordLabel(result.warlord),
    merged: result.merged,
    warnings: [`名将修行の画面なので、立ち絵から「${found.is_special ? "【特】" : ""}${found.name}」と判断しました`, ...result.warnings],
    meisho_stage: null,
    meisho_ids: null,
    server_req: null,
  });
}

// ---------------- 立ち絵の確認 (サーバーに任せる) ----------------

/** 立ち絵の確認を AI に尋ねる依頼をサーバーに預ける。答えが届いたら、この端末で保存をやり直す */
async function startServerArtCheck(job: OcrJob, extraction: OcrExtraction, need: NeedServerArtCheck) {
  const key = `${need.candidate.id}${need.strict ? "!" : ""}`;
  const answers = { ...(job.art_answers ?? {}) };
  const parts = await buildArtCheckRequest(job.image_id, need.candidate);
  if (!parts) {
    // 見比べる画像が無い: 分からないとして保存をやり直す
    answers[key] = "unknown";
    await update(job, { status: "queued", extraction, local: true, art_answers: answers, art_pending: null });
    void runQueue();
    return;
  }
  const settings = loadSettings();
  const req = `${job.id}~a-${Date.now().toString(36)}`;
  await callServer(settings, "enqueue", { id: req, model: settings.geminiModel, body: buildGeminiPartsBody(parts, ART_CHECK_SCHEMA, 256) });
  await update(job, { status: "remote", extraction, local: true, art_answers: answers, art_pending: key, server_req: req, meisho_stage: null });
  kickServer();
}

/** サーバーから立ち絵の確認の答えが届いた: 答えを覚えて、保存をやり直す (この端末で。AI は使わない) */
async function applyArtAnswer(job: OcrJob, text: string) {
  const key = job.art_pending ?? "";
  const answers = { ...(job.art_answers ?? {}), [key]: interpretAnswer(text, key.endsWith("!")) };
  await update(job, { status: "queued", local: true, art_answers: answers, art_pending: null, server_req: null });
  void runQueue();
}

/** 天賦だけを読み直すジョブ: 武将の画像をまとめて AI に見せ、天賦を位置から決め直して置き換える */
async function processTalentReread(job: OcrJob) {
  const w = job.target_id ? await db.getWarlord(job.target_id) : null;
  if (!w) throw new Error("天賦を読み直す武将が見つかりません");
  const tr = await import("./talentReread.ts");
  // バックグラウンド解析がオンなら、サーバーに任せる (アプリを閉じていても進む)
  if (bgActive(loadSettings()) && !job.local) {
    const settings = loadSettings();
    const body = buildGeminiPartsBody(await tr.buildTalentRequest(w), tr.TALENT_SCHEMA, tr.TALENT_MAX_TOKENS);
    await callServer(settings, "enqueue", { id: job.id, model: settings.geminiModel, body });
    await update(job, { status: "remote", server_req: null, meisho_stage: null, art_pending: null });
    kickServer();
    return;
  }
  await saveTalents(job, w.id, await tr.rereadTalents(w));
}

/** 読み直した天賦を武将に保存して、ジョブを終える */
async function saveTalents(job: OcrJob, warlordId: string, talents: Talent[]) {
  const w = { id: warlordId };
  const saved = await ingestLock(async () => {
    const fresh = await db.getWarlord(w.id);
    if (!fresh) throw new Error("天賦を読み直す武将が見つかりません");
    const { id: _i, created_at: _c, updated_at: _u, screenshot_count: _s, ...input } = fresh;
    return db.updateWarlord(fresh.id, normalizeInput({ ...input, talents, talent_order_v2: true, talent_ai_read: true }));
  });
  await update(job, {
    status: "done",
    warlord_id: saved.id,
    warlord_label: warlordLabel(saved),
    merged: true,
    warnings: talents.length < 5 ? [`天賦を ${talents.length} 個しか読み取れませんでした`] : [],
    extraction: null,
  });
}

async function processJob(job: OcrJob) {
  const startedAt = Date.now();
  let extraction: OcrExtraction | null = job.extraction ?? null;
  try {
    if (job.talents_only) return await processTalentReread(job);
    const image = await db.getImage(job.image_id);
    if (!image) throw new Error("画像が見つかりません");
    if (!extraction) {
      if (bgActive(loadSettings()) && !job.local) return await sendToServer(job, image);
      extraction = await analyzeWithRetry(image, job.mode, loadSettings());
    }
    const result = await ingestJob(job, extraction);
    await db.putExtraction(job.image_id, extraction).catch(() => {});
    // 解析が終わった画像は保存用の大きさに縮めて容量を節約する
    try {
      await db.putImage(await shrinkForGallery(image), job.image_id);
    } catch {
      /* 縮小できなくても解析結果には影響しない */
    }
    // 同じスクショが 2 重に入ったら 1 枚にまとめる
    await ingestLock(() => dedupeWarlordImages(result.warlord.id)).catch(() => 0);
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
    if (err instanceof JobCancelled) return;
    if (err instanceof NeedServerArtCheck && extraction) {
      // 立ち絵の確認で AI に尋ねるところだけ、サーバーに任せる
      try {
        return await startServerArtCheck(job, extraction, err);
      } catch {
        await update(job, { status: "queued", extraction, local: true });
        return;
      }
    }
    if (err instanceof NeedServerIdentify && extraction) {
      // 名将修行の画面: 誰の画面かの見分けをサーバーに任せる
      try {
        return await startServerIdentify(job, extraction);
      } catch (e) {
        return meishoFail(job, extraction, `見分けの依頼をサーバーに送れませんでした (${e instanceof Error ? e.message : String(e)})。「再試行」を押してください`);
      }
    }
    if (err instanceof OcrError && err.rateLimited) {
      // 上限に達した: このジョブは (読み取り済みならその結果を残して) 待機に戻し、キュー全体を少し休ませる
      pauseForRateLimit(err);
      await update(job, { status: "queued", attempts: Math.max(0, job.attempts - 1), extraction });
      return;
    }
    if (err instanceof ServerError && !extraction && job.attempts < 3) {
      // サーバーへの送信が時間切れ・つながらなかった: 少し待って送り直す (3 回まで)
      await sleep(5_000);
      await update(job, { status: "queued" });
      return;
    }
    if (lastHiddenAt >= startedAt) {
      // アプリを離れたせいで止まった分は、失敗にせず (回数にも数えず) やり直す
      await update(job, { status: "queued", attempts: Math.max(0, job.attempts - 1), extraction });
      return;
    }
    if (job.talents_only && err instanceof OcrError && err.retryable && job.attempts < 6) {
      // 天賦の読み直しで Gemini が混み合っている (503 など): 失敗にせず、間をあけてやり直す (6 回まで)。
      // 混んでいる間は他のジョブも同じように失敗するので、キュー全体を休ませる
      pausedUntil = Math.max(pausedUntil, Date.now() + Math.max(15_000 * job.attempts, err.retryAfterMs));
      pauseReason = err.message;
      await update(job, { status: "queued" });
      return;
    }
    if (extraction && err instanceof OcrError && err.retryable && job.attempts < 3) {
      // 立ち絵の確認が一時的に失敗した: 少し待ってからやり直す (3 回まで。回数は戻さない)
      pausedUntil = Math.max(pausedUntil, Date.now() + Math.max(5_000, err.retryAfterMs));
      pauseReason = err.message;
      await update(job, { status: "queued", extraction });
      return;
    }
    console.error(`[ocr] ${job.file_name}:`, err);
    // 読み取り済みなら結果を残す (再試行や「統合先を選んで保存」で読み取りを繰り返さない)
    await update(job, { status: "error", error: err instanceof Error ? err.message : String(err), extraction, ...(extraction ? { local: true } : {}) });
  }
}

/** サーバーへ送るだけのジョブ (この端末の AI を使わない) */
const isUpload = (j: OcrJob) => !j.local && !j.talents_only && !j.extraction;
/** サーバーの解析待ちを「動いている」とみなす時間 (これより古いものは止まっているかもしれないので、天賦の読み直しを待たせない) */
const REMOTE_ACTIVE_MS = 30 * 60_000;

/** サーバーに一度に預ける天賦の読み直しの数 (新しいスクショの解析が、その後ろで待たされすぎないように) */
const MAX_REMOTE_TALENTS = 50;

/**
 * 次に取りかかるジョブを、優先順に選ぶ (同じ順位なら登録順):
 *  0. サーバーへ送るだけのジョブ (この端末の AI を使わないので、上限で休んでいる間も送る)
 *  1. 読み取り済みで、保存 (立ち絵の確認) だけが残っているジョブ (サーバーの結果など)
 *  2. この端末で解析するジョブ
 *  3. 天賦の読み直し (いちばん後回し。同じ API キーの無料枠を使うので、新しいスクショの解析が動いている間は始めない)
 *     バックグラウンド解析がオンならサーバーに任せる (アプリを閉じていても進む)。預けるのは一度に 50 件まで
 */
async function pickNextJob(paused: boolean): Promise<OcrJob | null> {
  const jobs = (await db.listJobs()).reverse(); // 登録順
  const bg = bgActive(loadSettings());
  const now = Date.now();
  const remoteActive = (j: OcrJob) => j.status === "remote" && now - Date.parse(j.updated_at) < REMOTE_ACTIVE_MS;
  // 新しいスクショの解析がサーバーで動いている・送るのを待っている
  const screenshotsBusy = bg && jobs.some((j) => (remoteActive(j) && !j.talents_only) || (j.status === "queued" && isUpload(j)));
  const otherWork = jobs.some((j) => j.status === "queued" && !j.talents_only);
  const remoteTalents = jobs.filter((j) => j.talents_only && remoteActive(j)).length;
  const rank = (j: OcrJob): number | null => {
    if (j.status !== "queued") return null;
    if (bg && isUpload(j)) return 0;
    if (paused) return null;
    if (j.extraction) return 1;
    if (j.talents_only) {
      if (screenshotsBusy) return null;
      if (bg && !j.local) return remoteTalents < MAX_REMOTE_TALENTS ? 3 : null;
      return otherWork ? null : 3;
    }
    return 2;
  };
  let best: OcrJob | null = null;
  let bestRank = Infinity;
  for (const j of jobs) {
    const r = rank(j);
    if (r !== null && r < bestRank) {
      best = j;
      bestRank = r;
    }
  }
  return best;
}

async function worker() {
  for (;;) {
    if (typeof document !== "undefined" && document.hidden) return; // 裏にいる間は始めない
    const paused = pausedUntil > Date.now();
    // 次のジョブを取り出して「解析中」にするまでを 1 人ずつ行い、同じジョブを二重に取らないようにする
    const job = await claimLock(async () => {
      const next = await pickNextJob(paused);
      if (!next) return null;
      return update(next, { status: "processing", attempts: next.attempts + 1, started_at: new Date().toISOString() });
    });
    if (!job) {
      // 休んでいる間に待っているジョブがあれば、休みが明けるまで待つ (その間に送るジョブが来れば送る)
      if (paused && (await db.nextQueuedJob())) {
        await sleep(Math.max(200, Math.min(1000, pausedUntil - Date.now())));
        continue;
      }
      // 天賦の読み直しだけが、サーバーの解析が終わるのを待っている: サーバーの結果を受け取った後に再開する
      return;
    }
    await processJob(job);
  }
}

export async function runQueue() {
  const upload = bgActive(loadSettings()) ? await db.nextQueuedJob(isUpload) : null;
  const limit = upload ? UPLOAD_CONCURRENCY : CONCURRENCY;
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
let pollAgain = false;
export async function pollServer(): Promise<void> {
  const settings = loadSettings();
  if (!bgActive(settings)) return;
  if (polling) {
    pollAgain = true; // 受け取り中に新しい結果ができた: 今の受け取りが終わったらもう一度
    return;
  }
  pollAgain = false;
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
      let unacked: string[] = [];
      // 進み具合の表示: 今回受け取った分と、サーバーにまだ残っている分
      // (サーバーの「受け取り待ち」には、今回受け取った分も含まれる)
      const done = receiving?.done ?? 0;
      receiving = { done, total: done + Math.max(res.results.length, (res as Partial<ServerCounts>).ready ?? 0) };
      notify();
      // 受け取り済みを少しずつサーバーに知らせる (途中でアプリを閉じても、やり直す分が少なくて済む)
      const flushAck = async () => {
        if (unacked.length === 0) return;
        const ids = unacked;
        unacked = [];
        await callServer(settings, "ack", { ids });
      };
      for (const r of res.results) {
        received.push(r.id);
        unacked.push(r.id);
        // 名将修行の見分けの依頼は「ジョブ ID~m1」のような名前で預けている
        const job = await db.getJob(r.id.split("~")[0]);
        // 今待っている依頼の答えだけ使う (取り消し・送り直しの前の古い依頼の答えは捨てる)
        const expected = job?.server_req ?? job?.id;
        if (job && job.status === "remote" && r.id === expected) await applyServerResult(job, r, settings.geminiModel); // 取り消し済みなどは飛ばす
        receiving = { done: (receiving?.done ?? 0) + 1, total: Math.max(receiving?.total ?? 0, (receiving?.done ?? 0) + 1) };
        notify();
        if (unacked.length >= 10) await flushAck();
        if (typeof document !== "undefined" && document.hidden) break; // 裏に回ったら、残りは次に開いた時に
      }
      await flushAck();
      if (typeof document !== "undefined" && document.hidden) break;
      if (res.results.length < 30) {
        if (serverCounts) serverCounts = { ...serverCounts, ready: Math.max(0, serverCounts.ready - received.length) };
        break;
      }
    }
    if (serverCounts && serverCounts.pending > 0) kickServer();
    // サーバーの解析が終わるのを待っていた天賦の読み直しなどを再開する
    void runQueue();
    // 版 2 以前のサーバーは止まっている理由を返さないので、止まっていればアプリから上限を確かめる
    if (!serverCounts?.limit && serverVersion < 3 && isStalled(await db.listJobs(), lastResultAt)) {
      await probeIfNeeded(settings);
    }
  } catch (err) {
    serverError = err instanceof Error ? err.message : String(err);
  } finally {
    polling = false;
    receiving = null;
    notify();
  }
  if (pollAgain) return pollServer();
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
    if (job.art_pending) {
      // 立ち絵の確認の答え (サーバーに任せた分)
      extraction = job.extraction ?? null;
      await applyArtAnswer(job, geminiRestText(r.body ?? ""));
      return;
    }
    if (job.meisho_stage) {
      // 名将修行の画面の見分けの答え (サーバーに任せた分)。失敗した時に読み取り結果を残すよう、先に入れておく
      extraction = job.extraction ?? null;
      await applyMeishoAnswer(job, geminiRestText(r.body ?? ""));
      return;
    }
    if (job.talents_only) {
      // 天賦の読み直しの結果 (サーバーに任せた分)
      const { parseTalentAnswer } = await import("./talentReread.ts");
      if (!job.target_id) throw new Error("天賦を読み直す武将が見つかりません");
      await saveTalents(job, job.target_id, parseTalentAnswer(geminiRestText(r.body ?? "")));
      return;
    }
    extraction = parseGeminiRestBody(r.body ?? "");
    const result = await ingestJob(job, extraction);
    await db.putExtraction(job.image_id, extraction).catch(() => {});
    // 縮小は待たずに次の結果へ (ただし iPhone のメモリを食わないよう、縮小どうしは 1 枚ずつ)。
    // 縮小し終えたら、同じスクショが 2 重に入っていないか確かめる (縮小前後で中身が変わるため、縮小の後で)
    const warlordId = result.warlord.id;
    shrinkChain = shrinkChain
      .then(() => shrinkStoredImage(job.image_id))
      .then(() => ingestLock(() => dedupeWarlordImages(warlordId)))
      .then(() => undefined)
      .catch(() => undefined);
    await update(job, {
      status: "done",
      warlord_id: result.warlord.id,
      warlord_label: warlordLabel(result.warlord),
      merged: result.merged,
      warnings: result.warnings,
    });
  } catch (err) {
    if (err instanceof JobCancelled) return;
    // サーバーの結果を保存する途中で、AI に尋ねる所 (立ち絵の確認・名将修行の画面の見分け) に来た: そこもサーバーに任せる
    if (err instanceof NeedServerArtCheck && extraction) {
      try {
        return await startServerArtCheck(job, extraction, err);
      } catch {
        await update(job, { status: "queued", extraction, local: true });
        return;
      }
    }
    if (err instanceof NeedServerIdentify && extraction) {
      try {
        return await startServerIdentify(job, extraction);
      } catch (e) {
        return meishoFail(job, extraction, `見分けの依頼をサーバーに送れませんでした (${e instanceof Error ? e.message : String(e)})。「再試行」を押してください`);
      }
    }
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
    // 読み取り済みなら結果を残す (再試行や「統合先を選んで保存」で読み取りを繰り返さない)
    await update(job, { status: "error", error: err instanceof Error ? err.message : String(err), extraction, ...(extraction ? { local: true } : {}) });
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
    await callServer(settings, "cancel", { ids: remote.map((j) => j.server_req ?? j.id) });
  } catch {
    /* サーバーに届かなくても続ける */
  }
  // 取り消しを待つ間に結果を受け取り終えたジョブは、引き取らない (同じ画像を二重に解析しないように)
  let moved = 0;
  for (const job of remote) {
    const fresh = await db.getJob(job.id);
    if (!fresh || fresh.status !== "remote") continue;
    await update(fresh, { status: "queued", local: true, attempts: 0 });
    moved++;
  }
  notify();
  void runQueue();
  return moved;
}

/**
 * この iPhone で直接解析することになっている待機中のジョブを、サーバーに任せ直す (アプリを閉じていても進むように)。
 * 読み取り済みで保存だけ残っている分は、図鑑がこの iPhone にあるので戻せない
 */
export async function sendLocalJobsToServer() {
  if (!bgActive(loadSettings())) return 0;
  let moved = 0;
  for (const job of await db.listJobs()) {
    if (job.status !== "queued" || !job.local || job.extraction) continue;
    await update(job, { local: false, attempts: 0 });
    moved++;
  }
  notify();
  void runQueue();
  return moved;
}

/**
 * サーバーで解析待ちの依頼を取り消し、今の設定のモデルで送り直す。
 * 依頼にはモデルが書き込まれているので、モデルを切り替えた後は送り直さないと新しいモデルで解析されない。
 */
export async function resendRemoteJobs() {
  const settings = loadSettings();
  const remote = (await db.listJobs()).filter((j) => j.status === "remote");
  if (remote.length === 0 || !bgActive(settings)) return 0;
  await callServer(settings, "cancel", { ids: remote.map((j) => j.server_req ?? j.id) });
  let moved = 0;
  for (const job of remote) {
    const fresh = await db.getJob(job.id);
    if (!fresh || fresh.status !== "remote") continue;
    await update(fresh, { status: "queued", local: false, attempts: 0 });
    moved++;
  }
  resumeNow();
  return moved;
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
      await callServer(settings, "cancel", { ids: removable.filter((j) => j.status === "remote").map((j) => j.server_req ?? j.id) });
    } catch {
      /* サーバーに届かなくても、結果が来た時に取り消し済みとして捨てる */
    }
  }
  await db.deleteJobs(removable.map((j) => j.id));
  await db.removeUnreferencedImages(removable.map((j) => j.image_id));
  notify();
  return removable.length;
}
