import type { Warlord } from "../../core/types.ts";
import type { ArtCheck } from "../../core/ingest.ts";
import * as db from "./db.ts";
import { artSignature, blobToBase64, cropLeft, signatureSimilarity } from "./images.ts";
import { geminiHttpError } from "./geminiShared.ts";
import { OcrError } from "./ocrCommon.ts";
import { loadSettings, type Settings } from "./settings.ts";

// 同じ名前の武将が登録済みの時、画面左側の立ち絵が同じかを確かめる (通常武将と特異武将は立ち絵が違う)。
// まず端末だけで見比べ、ほぼ同じ絵なら AI には尋ねない。迷う時だけ AI に 1 回尋ねる (無料枠の回数を 1 回使う)。

/** これ以上似ていれば、同じ立ち絵とみなして AI に尋ねない */
const SAME_THRESHOLD = 0.95;
/** 見比べに使う登録画像の枚数 */
const LOCAL_SAMPLES = 6;
const AI_SAMPLES = 2;

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
  "スマホゲーム『戦国布武』の武将画面のスクリーンショットから、画面左側の武将の立ち絵 (キャラクターのイラスト) を切り出した画像です。",
  "最初の画像 (見本) は登録済みの武将の立ち絵、最後の画像は判定する画像です。",
  "同じ武将名でも、通常武将と特異武将は立ち絵 (衣装・髪型・色・持ち物・ポーズ) が違います。文字・枠・背景は無視し、人物のイラストだけを比べてください。",
  "判定する画像の人物のイラストは、見本と同じイラストですか。",
  "次のどれか 1 語だけを答えてください: SAME (同じイラスト) / DIFFERENT (違うイラスト) / UNKNOWN (判定する画像に人物のイラストが写っていない)",
].join("\n");

type Part = { text: string } | { image: string };

async function ask(parts: Part[], settings: Settings): Promise<string> {
  if (settings.provider === "claude") {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true, timeout: 45_000, maxRetries: 1 });
    try {
      const res = await client.messages.create({
        model: settings.model,
        max_tokens: 20,
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
      config: { temperature: 0 },
    });
    return res.text ?? "";
  } catch (err) {
    if (err instanceof ApiError) throw geminiHttpError(err.status, err.message ?? "", settings.geminiModel);
    throw new OcrError(`立ち絵の確認に失敗しました: ${err instanceof Error ? err.message : String(err)}`, true, 5_000);
  }
}

/** 判定する画像 (端末内の画像 ID) が、登録済みの武将と同じ立ち絵かを確かめる関数を作る */
export function artChecker(imageId: string): ArtCheck {
  return async (candidate) => {
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

    // 迷う時は AI に尋ねる
    const targetBlob = await db.getImage(imageId);
    if (!targetBlob) return "unknown";
    const parts: Part[] = [{ text: PROMPT }, { text: "見本:" }];
    for (const id of ids.slice(0, AI_SAMPLES)) {
      const blob = await db.getImage(id);
      if (blob) parts.push({ image: await blobToBase64(await cropLeft(blob)) });
    }
    parts.push({ text: "判定する画像:" }, { image: await blobToBase64(await cropLeft(targetBlob)) });
    const answer = (await ask(parts, loadSettings())).toUpperCase();
    if (/DIFFERENT/.test(answer)) return "different";
    if (/SAME/.test(answer)) return "same";
    return "unknown";
  };
}
