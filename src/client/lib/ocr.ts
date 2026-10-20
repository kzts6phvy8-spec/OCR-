import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { UploadMode } from "../../core/types.ts";
import { OcrExtractionSchema, type OcrExtraction } from "../../core/ocrSchema.ts";
import { SYSTEM_PROMPT } from "../../core/prompt.ts";
import { blobToBase64 } from "./images.ts";
import type { Settings } from "./settings.ts";
import { OcrError, modeHint } from "./ocrCommon.ts";

const TIMEOUT_MS = 45_000;
const MAX_RETRIES = 2;

// 端末から直接 Anthropic API を呼ぶ。API キーは利用者本人のもので、この端末内にだけ保存されている。
function client(settings: Settings) {
  return new Anthropic({
    apiKey: settings.apiKey,
    dangerouslyAllowBrowser: true,
    timeout: TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
  });
}

function toOcrError(err: unknown, settings: Settings): OcrError {
  if (err instanceof OcrError) return err;
  if (err instanceof Anthropic.AuthenticationError) return new OcrError("API キーが無効です。設定画面で確認してください", false);
  if (err instanceof Anthropic.PermissionDeniedError) return new OcrError("この API キーでは利用できません (権限エラー)", false);
  if (err instanceof Anthropic.NotFoundError) return new OcrError(`モデル「${settings.model}」が見つかりません`, false);
  if (err instanceof Anthropic.BadRequestError) {
    return /credit|balance/i.test(err.message)
      ? new OcrError("API のクレジット残高が不足しています (Anthropic Console でチャージしてください)", false)
      : new OcrError(`リクエストが不正です: ${err.message}`, false);
  }
  if (err instanceof Anthropic.RateLimitError) return new OcrError("利用上限に達しました。しばらく待って再試行してください", false);
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new OcrError(`AI の応答がタイムアウトしました (${TIMEOUT_MS / 1000} 秒 × ${MAX_RETRIES + 1} 回)`, false);
  }
  if (err instanceof Anthropic.APIConnectionError) return new OcrError("通信できませんでした。電波状況を確認してください", false);
  if (err instanceof Anthropic.APIError) return new OcrError(`API エラー (${err.status}): ${err.message}`, false);
  // 構造化出力の JSON 解析・スキーマ検証の失敗は再試行対象
  const retryable = err instanceof SyntaxError || (err instanceof Error && err.name === "ZodError");
  return new OcrError(err instanceof Error ? err.message : String(err), retryable);
}

export async function analyzeScreenshot(image: Blob, mode: UploadMode, settings: Settings): Promise<OcrExtraction> {
  if (!settings.apiKey) throw new OcrError("API キーが未設定です。「設定」から登録してください", false);
  const data = await blobToBase64(image);
  try {
    const response = await client(settings).beta.messages.parse({
      model: settings.model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: settings.effort, format: betaZodOutputFormat(OcrExtractionSchema) },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
            { type: "text", text: `このスクリーンショットから武将情報を読み取り、JSON で返してください。${modeHint(mode)}` },
          ],
        },
      ],
    });
    if (response.stop_reason === "refusal") {
      throw new OcrError(`AI が解析を拒否しました (${response.stop_details?.category ?? "理由不明"})`, false);
    }
    if (response.stop_reason === "max_tokens") throw new OcrError("AI の出力が上限で途切れました", true);
    if (!response.parsed_output) throw new OcrError("AI の応答を JSON として解釈できませんでした", true);
    return response.parsed_output;
  } catch (err) {
    throw toOcrError(err, settings);
  }
}

/** API キーの確認 (モデル情報の取得だけなので料金はかからない) */
export async function testConnection(settings: Settings): Promise<string> {
  try {
    const m = await client(settings).models.retrieve(settings.model);
    return m.display_name;
  } catch (err) {
    throw toOcrError(err, settings);
  }
}
