import type { Warlord } from "../../core/types.ts";
import type { ArtCheck } from "../../core/ingest.ts";
import * as db from "./db.ts";
import { artSignature, blobToBase64, compressImage, signatureSimilarity } from "./images.ts";
import { geminiHttpError } from "./geminiShared.ts";
import { OcrError } from "./ocrCommon.ts";
import { loadSettings, type Settings } from "./settings.ts";

// 同じ名前の武将が登録済みの時、画面左側の立ち絵が同じかを確かめる (通常武将と特異武将は立ち絵が違う)。
// まず端末だけで見比べ、ほぼ同じ絵なら AI には尋ねない。迷う時だけ AI に 1 回尋ねる (無料枠の回数を 1 回使う)。

/** これ以上似ていれば、同じ立ち絵とみなして AI に尋ねない */
const SAME_THRESHOLD = 0.95;
/** 見比べに使う登録画像の枚数 */
const LOCAL_SAMPLES = 6;
const AI_SAMPLES = 3;
/** AI が「違う絵」と答えても、確信度がこれ未満なら同じ武将とみなす (取り違えより、分かれてしまう方が困るため) */
const DIFFERENT_CONFIDENCE = 80;

/** AI に見せる画面の大きさ (立ち絵の見比べには十分) */
const PREVIEW = { maxEdge: 1024, quality: 0.85 };

const signatures = new Map<string, Promise<Float32Array | null>>();
function signatureOf(imageId: string) {
  let p = signatures.get(imageId);
  if (!p) {
    p = db
      .getImage(imageId)
      .then((blob) => (blob ? artSignature(blob) : null))
      .catch(() => null);
    signatures.set(imageId, p);
  }
  return p;
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

type Part = { text: string } | { image: string };

async function ask(parts: Part[], settings: Settings): Promise<string> {
  if (settings.provider === "claude") {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true, timeout: 45_000, maxRetries: 1 });
    try {
      const res = await client.messages.create({
        model: settings.model,
        max_tokens: 100,
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
      config: { temperature: 0, responseMimeType: "application/json", responseJsonSchema: RESPONSE_SCHEMA },
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
export function artChecker(imageId: string): ArtCheck {
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
    }
    if (opts.localOnly) return "unknown";

    // 迷う時は AI に尋ねる。画面ごとの立ち絵の見え方の違いに惑わされないよう、切り抜かずに画面全体を見せる
    const targetBlob = await db.getImage(imageId);
    if (!targetBlob) return "unknown";
    const parts: Part[] = [{ text: PROMPT }, { text: "見本:" }];
    for (const id of ids.slice(0, AI_SAMPLES)) {
      const blob = await db.getImage(id);
      if (blob) parts.push({ image: await blobToBase64(await compressImage(blob, PREVIEW)) });
    }
    parts.push({ text: "判定する画像:" }, { image: await blobToBase64(await compressImage(targetBlob, PREVIEW)) });
    return interpretAnswer(await ask(parts, loadSettings()), opts.strict);
  };
}
