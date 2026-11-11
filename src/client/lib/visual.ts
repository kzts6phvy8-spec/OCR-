import type { Warlord } from "../../core/types.ts";
import type { ArtCheck } from "../../core/ingest.ts";
import { MAX_IMAGES_PER_WARLORD } from "../../core/health.ts";
import * as db from "./db.ts";
import { artSignature, blobToBase64, compressImage, signatureSimilarity } from "./images.ts";
import { geminiHttpError } from "./geminiShared.ts";
import { OcrError } from "./ocrCommon.ts";
import { loadSettings, type Settings } from "./settings.ts";

// 同じ名前の武将が登録済みの時、画面左側の立ち絵が同じかを確かめる (通常武将と特異武将は立ち絵が違う)。
// まず端末だけで見比べ、ほぼ同じ絵なら AI には尋ねない。迷う時だけ AI に 1 回尋ねる (無料枠の回数を 1 回使う)。

/** これ以上似ていれば、同じ立ち絵とみなして AI に尋ねない */
// 画面の枠や背景が大きく写る画面では、違う立ち絵でも指紋がかなり似ることがあるので、ほぼ同じ画像の時だけにする
const SAME_THRESHOLD = 0.985;
/** 見比べに使う登録画像の枚数 */
const LOCAL_SAMPLES = 6;
const AI_SAMPLES = 3;
/** AI が「違う絵」と答えても、確信度がこれ未満なら同じ武将とみなす (取り違えより、分かれてしまう方が困るため) */
const DIFFERENT_CONFIDENCE = 80;

/** AI に見せる画面の大きさ (立ち絵の見比べには十分) */
const PREVIEW = { maxEdge: 1024, quality: 0.85 };

// ---- 立ち絵の指紋 (端末内に保存し、画像を開かずに見比べる) ----

const signatures = new Map<string, Promise<Float32Array | null>>();
function signatureOf(imageId: string) {
  let p = signatures.get(imageId);
  if (!p) {
    p = (async () => {
      const saved = await db.getSignature(imageId).catch(() => null);
      if (saved) return saved;
      const blob = await db.getImage(imageId);
      if (!blob) return null;
      const sig = await artSignature(blob);
      await db.putSignature(imageId, sig).catch(() => {});
      return sig;
    })().catch(() => null);
    signatures.set(imageId, p);
  }
  return p;
}

/** 画像の指紋をまとめて (保存済みのものは読むだけ、無ければ作る) */
export async function signaturesOf(imageIds: string[]): Promise<Map<string, Float32Array>> {
  const out = new Map<string, Float32Array>();
  for (const id of imageIds) {
    const sig = await signatureOf(id);
    if (sig) out.set(id, sig);
  }
  return out;
}

/**
 * 見比べの基準にする、図鑑に登録済みの画像の指紋 (画像 ID → 指紋・持ち主の武将)。
 * 結果を続けて保存する間に何度も作り直さないよう、30 秒は使い回す。
 */
let references: Promise<{ sigs: Map<string, Float32Array>; owner: Map<string, string> }> | null = null;
let referencesAt = 0;
function loadReferences() {
  if (!references || Date.now() - referencesAt > 30_000) {
    referencesAt = Date.now();
    references = (async () => {
      const owner = new Map<string, string>();
      for (const w of await db.listWarlords()) for (const id of w.gallery_images) owner.set(id, w.id);
      const sigs = new Map<string, Float32Array>();
      for (const [id, sig] of await db.listSignatures()) if (owner.has(id)) sigs.set(id, sig);
      return { sigs, owner };
    })();
  }
  return references;
}

/** 比べる相手として十分な数の指紋が無いうちは、端末だけの判断はしない */
const MIN_REFERENCES = 20;
/**
 * 候補の武将の画像にこれ以上似ていて、しかも他のどの武将の画像よりこれだけ多く似ていれば、同じ立ち絵とみなす。
 * 同じ人物の通常と特異は色合いが近いこともあるので、甘くしすぎない (取り違えると情報が混ざる)
 */
const RELATIVE_SAME = 0.95;
const RELATIVE_MARGIN = 0.15;

/**
 * 端末だけで「同じ立ち絵」と言えるか。候補の武将の画像が、他の武将 (同じ名前の別版も含む) の
 * どの画像よりもはっきり似ている時だけ「同じ」とする。画面の作り (枠や背景) が似ていても、相対的に比べるので惑わされにくい。
 */
async function clearlySame(imageId: string, target: Float32Array, candidate: Warlord): Promise<boolean> {
  const { sigs, owner } = await loadReferences();
  if (sigs.size < MIN_REFERENCES) return false;
  const mine = new Set(imagesOf(candidate));
  let best = -1;
  let other = -1;
  for (const [id, sig] of sigs) {
    if (id === imageId) continue;
    const sim = signatureSimilarity(target, sig);
    if (mine.has(id) || owner.get(id) === candidate.id) best = Math.max(best, sim);
    else other = Math.max(other, sim);
  }
  // 候補の画像の指紋がまだ基準に入っていなければ (登録したばかり等)、その場で作る
  for (const id of mine) {
    if (id === imageId || sigs.has(id)) continue;
    const sig = await signatureOf(id);
    if (sig) best = Math.max(best, signatureSimilarity(target, sig));
  }
  return best >= RELATIVE_SAME && best - other >= RELATIVE_MARGIN;
}

/**
 * まだ指紋の無い登録画像の指紋を、アプリを開いている間に少しずつ作る (次からの見比べを速くするため)。
 * 1 枚ずつ間を空けて作り、アプリが裏に回ったらやめる。
 */
let backfilling = false;
export async function backfillSignatures() {
  if (backfilling) return;
  backfilling = true;
  try {
    const have = await db.listSignatures();
    for (const id of await db.listImageIds()) {
      if (have.has(id)) continue;
      if (typeof document !== "undefined" && document.hidden) return;
      await signatureOf(id);
      signatures.delete(id); // 保存したのでメモリには持たない
      await new Promise((r) => setTimeout(r, 150));
    }
  } finally {
    backfilling = false;
  }
}

const imagesOf = (w: Warlord) => [...new Set([w.image_url, ...w.gallery_images].filter(Boolean))];

const PROMPT = [
  "スマホゲーム『戦国布武』の武将画面のスクリーンショットです。画面の左側に武将の大きな立ち絵 (人物のイラスト) があります。",
  "最初の数枚 (見本) は、登録済みの 1 人の武将のスクリーンショットです。最後の 1 枚が判定する画像です。",
  "見本と判定する画像は、ステータス・天賦・連携など違う画面のことがよくあります。画面の右側・文字・枠・数値の違いは無視してください。",
  "立ち絵だけを比べてください。画面によって立ち絵の大きさ・位置・明るさが少し違ったり、一部が隠れたりしても、同じイラストなら同じです。",
  "同じ武将名でも、通常武将と特異武将は立ち絵が別のイラスト (衣装・髪型・色・持ち物がはっきり違う) です。",
  "判定する画像の立ち絵が見本と同じイラストかを、JSON で答えてください。",
  '{"art_visible": 判定する画像に立ち絵が写っているか (true/false), "same": 同じイラストか (true/false), "confidence": 答えの確信度 (0〜100)}',
].join("\n");

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    art_visible: { type: "boolean" },
    same: { type: "boolean" },
    confidence: { type: "integer" },
  },
  required: ["art_visible", "same", "confidence"],
};

export type Part = { text: string } | { image: string };

export async function ask(parts: Part[], settings: Settings, schema: object = RESPONSE_SCHEMA, maxTokens = 100): Promise<string> {
  if (settings.provider === "claude") {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true, timeout: 45_000, maxRetries: 1 });
    try {
      const res = await client.messages.create({
        model: settings.model,
        max_tokens: maxTokens,
        messages: [
          {
            role: "user",
            content: parts.map((p) =>
              "text" in p
                ? { type: "text" as const, text: p.text }
                : { type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: p.image } },
            ),
          },
        ],
      });
      return res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) throw new OcrError("API の利用上限に達しました", false, 0, true);
      throw new OcrError(`立ち絵の確認に失敗しました: ${err instanceof Error ? err.message : String(err)}`, true, 5_000);
    }
  }
  const { ApiError, GoogleGenAI } = await import("@google/genai");
  const client = new GoogleGenAI({ apiKey: settings.geminiKey, httpOptions: { timeout: 45_000 } });
  try {
    const res = await client.models.generateContent({
      model: settings.geminiModel,
      contents: [{ role: "user", parts: parts.map((p) => ("text" in p ? { text: p.text } : { inlineData: { mimeType: "image/jpeg", data: p.image } })) }],
      config: { temperature: 0, responseMimeType: "application/json", responseJsonSchema: schema },
    });
    return res.text ?? "";
  } catch (err) {
    if (err instanceof ApiError) throw geminiHttpError(err.status, err.message ?? "", settings.geminiModel);
    throw new OcrError(`立ち絵の確認に失敗しました: ${err instanceof Error ? err.message : String(err)}`, true, 5_000);
  }
}

/** AI の答え (JSON。崩れていれば文字から読む) を「同じ / 違う / わからない」にする */
export function interpretAnswer(text: string, strict = false): "same" | "different" | "unknown" {
  let v: { art_visible?: boolean; same?: boolean; confidence?: number } | null = null;
  try {
    v = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    v = null;
  }
  if (!v || typeof v.same !== "boolean") {
    const t = text.toUpperCase();
    if (/DIFFERENT|"SAME"\s*:\s*FALSE/.test(t)) return "unknown"; // 形が崩れた「違う」は信用しない
    return /SAME/.test(t) ? "same" : "unknown";
  }
  if (v.art_visible === false) return "unknown";
  if (v.same) return "same";
  return strict || (v.confidence ?? 0) >= DIFFERENT_CONFIDENCE ? "different" : "same";
}

/** 判定する画像 (端末内の画像 ID) が、登録済みの武将と同じ立ち絵かを確かめる関数を作る */
/** 画面の種類 (基本情報・天賦・連携など) を比べやすくする */
const screenKey = (t: string) => t.normalize("NFKC").replace(/\s|画面|情報/g, "");

/**
 * 候補の武将が「同じ武将らしくない」手がかりがあるか。あれば、AI が迷った時に統合しない (確信が無ければ別の武将とする)。
 * - 画像がもう 6 枚ある (1 人の武将に統合される画像は多くても 6 枚)
 * - 判定する画像と同じ種類の画面 (天賦の画面どうし など) が、もう登録されている
 */
async function looksLikeAnother(candidate: Warlord, ids: string[], screens: string[]): Promise<boolean> {
  if (candidate.gallery_images.length >= MAX_IMAGES_PER_WARLORD) return true;
  const mine = new Set(screens.map(screenKey).filter(Boolean));
  if (mine.size === 0) return false;
  for (const id of ids) {
    const ext = await db.getExtraction(id).catch(() => null);
    if (ext?.screen_types.some((t) => mine.has(screenKey(t)))) return true;
  }
  return false;
}

/** 立ち絵の確認の AI への問い合わせを、サーバーに任せる合図 (保存の途中で投げ、ジョブをサーバーに預け直す) */
export class NeedServerArtCheck extends Error {
  constructor(
    readonly candidate: Warlord,
    readonly strict: boolean,
  ) {
    super("立ち絵の確認をサーバーに任せます");
  }
}

/** 立ち絵の確認を AI に尋ねる依頼 (見本の画像と判定する画像)。画像が無ければ null */
export async function buildArtCheckRequest(imageId: string, candidate: Warlord): Promise<Part[] | null> {
  const ids = imagesOf(candidate).filter((id) => id !== imageId);
  const targetBlob = await db.getImage(imageId);
  if (!targetBlob || ids.length === 0) return null;
  // 画面ごとの立ち絵の見え方の違いに惑わされないよう、切り抜かずに画面全体を見せる
  const parts: Part[] = [{ text: PROMPT }, { text: "見本:" }];
  for (const id of ids.slice(0, AI_SAMPLES)) {
    const blob = await db.getImage(id);
    if (blob) parts.push({ image: await blobToBase64(await compressImage(blob, PREVIEW)) });
  }
  parts.push({ text: "判定する画像:" }, { image: await blobToBase64(await compressImage(targetBlob, PREVIEW)) });
  return parts;
}

export const ART_CHECK_SCHEMA = RESPONSE_SCHEMA;

/**
 * 判定する画像 (端末内の画像 ID) が、登録済みの武将と同じ立ち絵かを確かめる関数を作る。
 * screens: 判定する画像に写っている画面の種類 (読み取り結果から)。
 * server: AI に尋ねる時はサーバーに任せる (answers にサーバーの答えがあればそれを使い、無ければ NeedServerArtCheck を投げる)
 */
export function artChecker(
  imageId: string,
  screens: string[] = [],
  server?: { answers: Record<string, "same" | "different" | "unknown"> },
): ArtCheck {
  return async (candidate, opts = {}) => {
    const ids = imagesOf(candidate).filter((id) => id !== imageId);
    if (ids.length === 0) return "unknown";

    // 端末だけで見比べる: ほぼ同じ絵なら同じ武将
    const target = await signatureOf(imageId);
    if (target) {
      let best = -1;
      for (const id of ids.slice(0, LOCAL_SAMPLES)) {
        const sig = await signatureOf(id);
        if (sig) best = Math.max(best, signatureSimilarity(target, sig));
      }
      if (best >= SAME_THRESHOLD) return "same";
      if (opts.localOnly) return "unknown";
      // ほぼ同じとまでは言えなくても、他の武将よりはっきり似ていれば AI に尋ねない
      if (await clearlySame(imageId, target, candidate)) return "same";
    }
    if (opts.localOnly) return "unknown";

    // 別の武将らしい手がかりがあれば、AI が迷った時 (確信の無い「違う」) も別の武将とする
    const strict = opts.strict || (await looksLikeAnother(candidate, ids, screens));
    // サーバーに任せる時: 答えが届いていればそれを使う。まだなら預け直す
    if (server) {
      const answer = server.answers[`${candidate.id}${strict ? "!" : ""}`];
      if (answer) return answer;
      throw new NeedServerArtCheck(candidate, strict);
    }
    // 迷う時は AI に尋ねる
    const parts = await buildArtCheckRequest(imageId, candidate);
    if (!parts) return "unknown";
    return interpretAnswer(await ask(parts, loadSettings()), strict);
  };
}

// ---- 立ち絵ごとの組分け (AI) ----

const GROUP_PROMPT = (n: number) =>
  [
    `スマホゲーム『戦国布武』の、同じ名前の武将のスクリーンショットが ${n} 枚あります (画像 1 〜 ${n})。`,
    "画面に写っている武将の立ち絵 (人物のイラスト) を比べ、同じイラストの画像どうしを同じ組にしてください。",
    "同じ名前でも、通常武将・特異武将・限定武将・鬼憑武将などは立ち絵が別のイラスト (衣装・髪型・色・持ち物・ポーズが違う) です。",
    "ステータス・天賦・連携など画面の種類の違いや、文字・枠・数値の違いは無視し、人物のイラストだけで判断してください。",
    `JSON で答えてください: {"groups": [画像 1 の組番号, 画像 2 の組番号, …]} (組番号は 1 から。立ち絵が写っていない画像は 0)`,
  ].join("\n");

const GROUP_SCHEMA = {
  type: "object",
  properties: { groups: { type: "array", items: { type: "integer" } } },
  required: ["groups"],
};

/** 1 回に AI に見せる画像の枚数 */
const MAX_GROUP_IMAGES = 12;

/**
 * 画像を立ち絵ごとの組に分ける (AI に全部を一度に見せて組分けさせる。端末の指紋は当てにしない)。
 * 枚数が多い時は、残りの画像を指紋がいちばん近い組に入れる。大きい組から順に返す。
 */
export async function groupByArtWithAi(imageIds: string[]): Promise<{ groups: string[][]; unknown: string[] }> {
  const shown = imageIds.slice(0, MAX_GROUP_IMAGES);
  const parts: Part[] = [{ text: GROUP_PROMPT(shown.length) }];
  const usable: string[] = [];
  for (const id of shown) {
    const blob = await db.getImage(id);
    if (!blob) continue;
    usable.push(id);
    parts.push({ text: `画像 ${usable.length}:` }, { image: await blobToBase64(await compressImage(blob, PREVIEW)) });
  }
  parts[0] = { text: GROUP_PROMPT(usable.length) };
  if (usable.length < 2) return { groups: usable.length ? [usable] : [], unknown: imageIds.filter((id) => !usable.includes(id)) };

  const text = await ask(parts, loadSettings(), GROUP_SCHEMA, 300);
  let labels: number[] = [];
  try {
    labels = (JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { groups?: number[] }).groups ?? [];
  } catch {
    labels = [];
  }
  if (labels.length !== usable.length) throw new OcrError("AI の組分けの答えを読み取れませんでした。もう一度お試しください", true, 3_000);

  const byLabel = new Map<number, string[]>();
  const unknown: string[] = [];
  usable.forEach((id, i) => {
    if (!labels[i]) unknown.push(id);
    else byLabel.set(labels[i], [...(byLabel.get(labels[i]) ?? []), id]);
  });
  const groups = [...byLabel.values()];
  // AI に見せきれなかった画像は、指紋がいちばん近い組へ
  for (const id of imageIds.filter((x) => !usable.includes(x) && !unknown.includes(x))) {
    const sig = await signatureOf(id);
    if (!sig || groups.length === 0) {
      unknown.push(id);
      continue;
    }
    let best = 0;
    let bestSim = -2;
    for (const [gi, g] of groups.entries()) {
      for (const gid of g) {
        const gs = await signatureOf(gid);
        if (gs && signatureSimilarity(sig, gs) > bestSim) {
          bestSim = signatureSimilarity(sig, gs);
          best = gi;
        }
      }
    }
    groups[best].push(id);
  }
  return { groups: groups.sort((a, b) => b.length - a.length), unknown };
}

// ---- 名将修行の画面の立ち絵から、どの名将かを見分ける ----

/** 一覧表 1 枚に並べる人数 */
const SHEET_SIZE = 36;
/** 名将修行の画面どうしのカードの絵が、これ以上似ていれば同じ武将 */
const TRAINING_SAME = 0.97;
/** 2 番目に似ている武将とこれだけ差があれば、取り違えではない */
const TRAINING_MARGIN = 0.03;

const trainingSigs = new Map<string, Promise<Float32Array | null>>();
function trainingSigOf(imageId: string) {
  let p = trainingSigs.get(imageId);
  if (!p) {
    p = (async () => {
      const blob = await db.getImage(imageId);
      if (!blob) return null;
      const { trainingCardSignature } = await import("./images.ts");
      return trainingCardSignature(blob);
    })().catch(() => null);
    trainingSigs.set(imageId, p);
  }
  return p;
}

/**
 * 名将修行の画面を、すでに名将に振り分けた名将修行の画面と見比べる (AI なし)。
 * 名将修行の画面は配置が同じなので、同じ武将ならカードの絵がほぼ同じになる
 */
export async function matchKnownTraining(imageId: string, warlords: Warlord[]): Promise<Warlord | null> {
  const target = await trainingSigOf(imageId);
  if (!target) return null;
  const scores: { w: Warlord; score: number }[] = [];
  for (const w of warlords) {
    let best = -1;
    for (const id of (w.meisho_images ?? []).filter((x) => x !== imageId)) {
      const sig = await trainingSigOf(id);
      if (sig) best = Math.max(best, signatureSimilarity(target, sig));
    }
    if (best > -1) scores.push({ w, score: best });
  }
  scores.sort((a, b) => b.score - a.score);
  const [first, second] = scores;
  if (!first || first.score < TRAINING_SAME) return null;
  if (second && first.score - second.score < TRAINING_MARGIN) return null;
  return first.w;
}

const SHORTLIST_PROMPT = (n: number) =>
  [
    "スマホゲーム『戦国布武』の武将のイラストを見比べてください。",
    "最初の画像 (判定するイラスト) は「名将修行」の画面のカードの絵です。",
    `続く一覧表には、名将の武将のイラストが番号 1 〜 ${n} の付いたマスに並んでいます。`,
    "判定するイラストと同じ人物のイラストの可能性が高いマスを、可能性の高い順に 3 つまで選んでください。",
    "白黒かカラーか・明るさ・切り抜き方・枠や文字の違いは無視し、顔・髪型・衣装・持ち物・ポーズで比べてください。",
    `JSON で答えてください: {"candidates": [マスの番号, …]}`,
  ].join("\n");

const SHORTLIST_SCHEMA = {
  type: "object",
  properties: { candidates: { type: "array", items: { type: "integer" } } },
  required: ["candidates"],
};

const CONFIRM_PROMPT = (n: number) =>
  [
    "スマホゲーム『戦国布武』の武将のイラストを見比べてください。",
    "最初の画像 (判定するイラスト) は「名将修行」の画面のカードの絵です。",
    `続く候補 1 〜 ${n} は、名将の武将の画面のイラストです。`,
    "判定するイラストと同じイラスト (同じ絵) の候補を選んでください。同じ名前でも衣装・髪型・持ち物・ポーズが違えば別の絵です。",
    "白黒かカラーか・明るさ・切り抜き方の違いは無視してください。",
    `JSON で答えてください: {"match": 候補の番号 (同じ絵が無ければ 0), "confidence": 0〜100}`,
  ].join("\n");

const CONFIRM_SCHEMA = {
  type: "object",
  properties: { match: { type: "integer" }, confidence: { type: "integer" } },
  required: ["match", "confidence"],
};

const parseJson = <T>(text: string): T | null => {
  try {
    return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as T;
  } catch {
    return null;
  }
};

/** 名将の候補 (立ち絵の画像が読める武将だけ) */
async function candidateBlobs(candidates: Warlord[]): Promise<{ w: Warlord; blob: Blob }[]> {
  const list: { w: Warlord; blob: Blob }[] = [];
  for (const w of candidates) {
    const id = w.image_url || w.gallery_images[0];
    const blob = id ? await db.getImage(id).catch(() => null) : null;
    if (blob) list.push({ w, blob });
  }
  return list;
}

async function targetArt(imageId: string): Promise<string | null> {
  const blob = await db.getImage(imageId);
  if (!blob) return null;
  const { cropArt } = await import("./images.ts");
  return blobToBase64(await cropArt(blob));
}

export const MEISHO_SHORTLIST_SCHEMA = SHORTLIST_SCHEMA;
export const MEISHO_CONFIRM_SCHEMA = CONFIRM_SCHEMA;

/**
 * 1 回目の依頼: 名将全員の立ち絵の一覧表から、似ている候補を 3 人まで選ばせる。
 * 候補が 3 人以下なら 1 回目は要らない (shortlist にそのまま入れて返す)
 */
export async function buildMeishoShortlistRequest(
  imageId: string,
  candidates: Warlord[],
): Promise<{ parts: Part[] | null; ids: string[] } | null> {
  const list = await candidateBlobs(candidates);
  if (list.length === 0) return null;
  if (list.length <= 3) return { parts: null, ids: list.map((x) => x.w.id) };
  const target = await targetArt(imageId);
  if (!target) return null;
  const { artContactSheet } = await import("./images.ts");
  const parts: Part[] = [{ text: SHORTLIST_PROMPT(list.length) }, { text: "判定するイラスト:" }, { image: target }];
  for (let i = 0; i < list.length; i += SHEET_SIZE) {
    const sheet = await artContactSheet(
      list.slice(i, i + SHEET_SIZE).map((x) => x.blob),
      i + 1,
    );
    parts.push({ text: `一覧表 (番号 ${i + 1} 〜 ${Math.min(i + SHEET_SIZE, list.length)}):` }, { image: await blobToBase64(sheet) });
  }
  return { parts, ids: list.map((x) => x.w.id) };
}

/** 1 回目の答えから、候補の武将 ID を取り出す (ids は依頼の番号順) */
export function parseMeishoShortlist(text: string, ids: string[]): string[] {
  const v = parseJson<{ candidates?: number[] }>(text);
  return [...new Set((v?.candidates ?? []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= ids.length))].slice(0, 3).map((n) => ids[n - 1]);
}

/** 2 回目の依頼: 候補の立ち絵を大きく見せて、同じ絵を 1 人選ばせる */
export async function buildMeishoConfirmRequest(imageId: string, shortlist: Warlord[]): Promise<{ parts: Part[]; ids: string[] } | null> {
  const list = await candidateBlobs(shortlist);
  if (list.length === 0) return null;
  const target = await targetArt(imageId);
  if (!target) return null;
  const { cropArt } = await import("./images.ts");
  const parts: Part[] = [{ text: CONFIRM_PROMPT(list.length) }, { text: "判定するイラスト:" }, { image: target }];
  for (const [i, c] of list.entries()) parts.push({ text: `候補 ${i + 1}:` }, { image: await blobToBase64(await cropArt(c.blob)) });
  return { parts, ids: list.map((x) => x.w.id) };
}

/** 2 回目の答えから、決まった武将 ID を取り出す (確信度 65 未満なら null) */
export function parseMeishoConfirm(text: string, ids: string[]): string | null {
  const v = parseJson<{ match?: number; confidence?: number }>(text);
  const n = Number(v?.match);
  if (!Number.isInteger(n) || n < 1 || n > ids.length || (v?.confidence ?? 0) < 65) return null;
  return ids[n - 1];
}

/**
 * 名将修行の画面 (武将名が書かれていない) の立ち絵が、登録済みの名将の誰かを、この端末から AI に尋ねて見分ける。
 * 1 回目: 名将全員の立ち絵の一覧表から、似ている候補を 3 人まで選ばせる。
 * 2 回目: その 3 人の立ち絵を大きく見せて、同じ絵を 1 人選ばせる (確信度 80 未満なら決めない)
 */
export async function identifyMeishoByArt(imageId: string, candidates: Warlord[]): Promise<Warlord | null> {
  const settings = loadSettings();
  const first = await buildMeishoShortlistRequest(imageId, candidates);
  if (!first) return null;
  const shortIds = first.parts ? parseMeishoShortlist(await ask(first.parts, settings, SHORTLIST_SCHEMA, 100), first.ids) : first.ids;
  const shortlist = shortIds.map((id) => candidates.find((w) => w.id === id)).filter((w): w is Warlord => Boolean(w));
  if (shortlist.length === 0) return null;
  const second = await buildMeishoConfirmRequest(imageId, shortlist);
  if (!second) return null;
  const id = parseMeishoConfirm(await ask(second.parts, settings, CONFIRM_SCHEMA, 100), second.ids);
  return id ? (candidates.find((w) => w.id === id) ?? null) : null;
}

/** 名将修行の画面を、カードの絵が同じものどうし (= 同じ名将) の組に分ける (AI なし) */
export async function groupTrainingImages(ids: string[]): Promise<string[][]> {
  const groups: { head: Float32Array; ids: string[] }[] = [];
  const loose: string[][] = [];
  for (const id of ids) {
    const sig = await trainingSigOf(id);
    if (!sig) {
      loose.push([id]);
      continue;
    }
    const g = groups.find((x) => signatureSimilarity(x.head, sig) >= TRAINING_SAME);
    if (g) g.ids.push(id);
    else groups.push({ head: sig, ids: [id] });
  }
  return [...groups.map((g) => g.ids), ...loose];
}
