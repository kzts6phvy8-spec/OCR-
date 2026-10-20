import fs from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import sharp from "sharp";
import type { UploadMode } from "../shared/types.ts";
import { config, hasApiKey } from "./config.ts";
import { OcrExtractionSchema, type OcrExtraction } from "./ocrSchema.ts";
import { SPECIAL_SIGNATURE_SKILLS } from "./domain.ts";

const signatureList = Object.entries(SPECIAL_SIGNATURE_SKILLS)
  .map(([name, skills]) => `${name}『${skills.join("』『")}』`)
  .join("、");

const SYSTEM_PROMPT = `あなたはスマホゲーム『戦国布武～我が天下戦国乱世演武～』の武将画面スクリーンショットを読み取る高精度 OCR エンジンです。
出力は必ず指定された JSON スキーマに従った JSON のみとし、マークダウンや解説を前後に含めないでください。

# 読み取りの原則
- 画面に実際に写っている文字だけを、表記どおり正確に書き写す。推測・補完・一般知識での穴埋めは禁止。
- 写っていない項目・読めない項目は null (配列は空配列) にする。0 や空文字で埋めない。
- スキル効果・天賦効果・連携効果は数値・％・括弧も含めて全文を書き写す。改行は詰めてよい。
- 1 枚の画像には一部の画面 (基本情報 / スキル詳細 / 覚醒 / 天賦 / 連携 / 兵種 など) しか写らないのが普通。写っている部分だけ埋める。

# 通常武将と特異武将の識別 (最重要)
同じ武将名でも「通常武将」と「特異武将」はステータスもスキルも全く別物。以下は画面上で実際に確認できた場合のみ true にする:
- special_icon_next_to_rating: 武将名の横にある「評価」ボタンの すぐ左隣 に【特】アイコンがある。
- special_text_marker: 武将名や二つ名に「特異」「【特】」「(特)」の表記がある。
参考: 特異武将の固有スキル例 — ${signatureList}。

# 覚醒スキルと専用武器覚醒 (混同厳禁)
- awakening.skill_name には覚醒スキル名だけを入れ、「(極高)」などの優先度は awakening.priority に分ける。
- 通常の覚醒効果は before_weapon_effect に入れる。
- 専用武器覚醒 (例: 『焦熱獄+』のような「+」付きの強化版、「武器覚醒後」「専用武器」等の表示) が この画像に写っている場合に限り weapon_awakening_visible=true とし、その効果を after_weapon_effect に入れる。
- 写っていなければ weapon_awakening_visible=false, after_weapon_effect=null。他の武将や通常版の知識から補わない。特異武将には武器覚醒が存在しない場合がある。

# その他
- 成長率は "+2.6" のように符号付き文字列で。成長値合計は "9" や "8.5"。
- 天賦は星1〜星5ごとに 1 件ずつ。グレーアウト・鍵マークなど未解放なら unlocked=false。
- 連携スキルは相手武将名と効果をセットで。`;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  client ??= new Anthropic({ timeout: config.timeoutMs, maxRetries: config.maxRetries });
  return client;
}

type MediaType = "image/png" | "image/jpeg" | "image/webp";
const MAX_EDGE = 2000;
const MAX_BYTES = 3.7 * 1024 * 1024; // base64 化後に API の 5MB 制限を超えないように

/** スマホのスクショは大きいので長辺 2000px に縮小し、サイズ超過時は JPEG に変換する */
export async function prepareImage(filePath: string): Promise<{ data: string; media_type: MediaType }> {
  const input = await fs.readFile(filePath);
  const image = sharp(input, { failOn: "none" }).rotate();
  const meta = await image.metadata();
  const resized = image.resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true });
  let buffer = await resized.clone().png({ compressionLevel: 9 }).toBuffer();
  let media_type: MediaType = "image/png";
  if (buffer.length > MAX_BYTES) {
    buffer = await resized.clone().jpeg({ quality: 90 }).toBuffer();
    media_type = "image/jpeg";
  }
  if (!meta.width) throw new Error("画像を読み込めませんでした");
  return { data: buffer.toString("base64"), media_type };
}

export class OcrError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

function modeHint(mode: UploadMode): string {
  if (mode === "force_normal") return "\n(ユーザー指定: この画像は通常武将です)";
  if (mode === "force_special") return "\n(ユーザー指定: この画像は特異武将です)";
  return "";
}

export async function analyzeScreenshot(filePath: string, mode: UploadMode): Promise<OcrExtraction> {
  const image = await prepareImage(filePath);
  try {
    const response = await getClient().beta.messages.parse({
      model: config.model,
      max_tokens: 16000,
      ...(config.fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      output_config: { effort: config.effort, format: betaZodOutputFormat(OcrExtractionSchema) },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: image.media_type, data: image.data } },
            {
              type: "text",
              text: `このスクリーンショットから武将情報を読み取り、JSON で返してください。${modeHint(mode)}`,
            },
          ],
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      throw new OcrError(`AI が解析を拒否しました (${response.stop_details?.category ?? "理由不明"})`, false);
    }
    if (response.stop_reason === "max_tokens") {
      throw new OcrError("AI の出力が上限で途切れました", true);
    }
    if (!response.parsed_output) {
      throw new OcrError("AI の応答を JSON として解釈できませんでした", true);
    }
    return response.parsed_output;
  } catch (err) {
    if (err instanceof OcrError) throw err;
    if (err instanceof Anthropic.AuthenticationError) {
      throw new OcrError("API キーが無効です。ANTHROPIC_API_KEY を確認してください", false);
    }
    if (err instanceof Anthropic.NotFoundError) {
      throw new OcrError(`モデル「${config.model}」が見つかりません。CLAUDE_MODEL を確認してください`, false);
    }
    if (err instanceof Anthropic.BadRequestError) {
      throw new OcrError(`リクエストが不正です: ${err.message}`, false);
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new OcrError("API のレート制限に達しました。しばらく待って再試行してください", false);
    }
    if (err instanceof Anthropic.APIConnectionTimeoutError) {
      throw new OcrError(`AI の応答がタイムアウトしました (${config.timeoutMs / 1000} 秒 × ${config.maxRetries + 1} 回)`, false);
    }
    if (err instanceof Anthropic.APIConnectionError) {
      throw new OcrError("API に接続できませんでした", false);
    }
    if (err instanceof Anthropic.APIError) {
      throw new OcrError(`API エラー (${err.status}): ${err.message}`, false);
    }
    if (!hasApiKey()) {
      throw new OcrError("API キーが設定されていません。.env に ANTHROPIC_API_KEY を設定してください", false);
    }
    // 構造化出力の JSON 解析・スキーマ検証の失敗は再試行対象
    const retryable = err instanceof SyntaxError || (err instanceof Error && err.name === "ZodError");
    throw new OcrError(err instanceof Error ? err.message : String(err), retryable);
  }
}

/**
 * 通信系 (429/5xx/タイムアウト/接続断) は SDK が maxRetries 回まで自動リトライ済み。
 * ここでは出力が途切れた・スキーマ不一致など、AI 出力側の問題だけを再試行する。
 */
export async function analyzeWithRetry(
  filePath: string,
  mode: UploadMode,
  attempts = 2,
): Promise<OcrExtraction> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await analyzeScreenshot(filePath, mode);
    } catch (err) {
      lastError = err;
      if (err instanceof OcrError && !err.retryable) break;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastError;
}
