import { z } from "zod";
import type { UploadMode } from "../../core/types.ts";
import { OcrExtractionSchema, type OcrExtraction } from "../../core/ocrSchema.ts";
import { SYSTEM_PROMPT } from "../../core/prompt.ts";
import { OcrError, modeHint } from "./ocrCommon.ts";

// Gemini への依頼内容と、応答の検証。端末から直接送る場合も、バックグラウンド解析サーバー経由の場合も同じものを使う。

/** Gemini に渡す JSON Schema (Claude と同じ Zod スキーマから生成) */
export const RESPONSE_SCHEMA = (() => {
  const s = z.toJSONSchema(OcrExtractionSchema) as Record<string, unknown>;
  delete s.$schema;
  return s;
})();

// 文字を書き写すだけなので、AI の「考える時間」は短くして速度を優先する。
// この設定に対応していないモデルだった場合は、端末に記録して以後は付けない。
const NO_THINKING_KEY = "gemini-thinking-level-unsupported";

export function thinkingLevelAllowed(): boolean {
  try {
    return localStorage.getItem(NO_THINKING_KEY) !== "1";
  } catch {
    return true;
  }
}

function markThinkingLevelUnsupported() {
  try {
    localStorage.setItem(NO_THINKING_KEY, "1");
  } catch {
    /* 保存できなくても、この回の再試行は付けずに送る */
  }
}

export const userText = (mode: UploadMode) => `このスクリーンショットから武将情報を読み取り、JSON で返してください。${modeHint(mode)}`;

/** REST API (generateContent) にそのまま送れる本文 */
export function buildGeminiBody(imageBase64: string, mode: UploadMode) {
  return {
    contents: [
      {
        role: "user",
        parts: [{ inlineData: { mimeType: "image/jpeg", data: imageBase64 } }, { text: userText(mode) }],
      },
    ],
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: RESPONSE_SCHEMA,
      // 小さな文字まで読めるよう、画像を高解像度で解析させる
      mediaResolution: "MEDIA_RESOLUTION_HIGH",
      temperature: 0,
      ...(thinkingLevelAllowed() ? { thinkingConfig: { thinkingLevel: "LOW" } } : {}),
    },
  };
}

/** 応答の文字列を JSON として読み、スキーマどおりか確かめる (崩れていれば再試行対象) */
export function parseExtractionText(text: string | undefined): OcrExtraction {
  if (!text) throw new OcrError("AI から応答がありませんでした", true);
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw new OcrError("AI の応答を JSON として解釈できませんでした", true);
  }
  const parsed = OcrExtractionSchema.safeParse(json);
  if (!parsed.success) throw new OcrError("AI の応答が決められた形式ではありませんでした", true);
  return parsed.data;
}

type RestResponse = {
  candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[];
  promptFeedback?: { blockReason?: string };
};

/** REST API の応答本文 (JSON 文字列) から読み取り結果を取り出す */
export function parseGeminiRestBody(body: string): OcrExtraction {
  let res: RestResponse;
  try {
    res = JSON.parse(body) as RestResponse;
  } catch {
    throw new OcrError("AI の応答を読み取れませんでした", true);
  }
  const cand = res.candidates?.[0];
  if (res.promptFeedback?.blockReason || cand?.finishReason === "SAFETY" || cand?.finishReason === "PROHIBITED_CONTENT") {
    throw new OcrError("AI が解析を拒否しました (安全フィルタ)", false);
  }
  if (cand?.finishReason === "MAX_TOKENS") throw new OcrError("AI の出力が上限で途切れました", true);
  const text = (cand?.content?.parts ?? [])
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join("");
  return parseExtractionText(text);
}

/** Gemini の HTTP エラー (状態コードと本文) を、利用者向けの説明に直す */
export function geminiHttpError(status: number, message: string, model: string): OcrError {
  if (status === 400 && /thinking/i.test(message)) {
    // 「考える時間」の設定に未対応のモデル: 設定を外してすぐやり直す (同時に送っていた他の依頼も同じく再試行)
    markThinkingLevelUnsupported();
    return new OcrError("AI の設定を調整して再試行します", true, 0);
  }
  if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(message)) {
    return new OcrError("Gemini の API キーが無効です。設定画面で確認してください", false);
  }
  if (status === 403) {
    const url = message.match(/https:\/\/console\.(?:developers|cloud)\.google\.com\/[^\s"'\\]+/)?.[0];
    if (/SERVICE_DISABLED|has not been used|is disabled/i.test(message)) {
      return new OcrError(
        `Gemini (Generative Language API) がまだ有効になっていません。${url ? `次のページを開いて「有効にする」を押してください: ${url}` : "Google Cloud で「Generative Language API」を有効にしてください"}`,
        false,
      );
    }
    return new OcrError(`この API キーでは Gemini を利用できません (権限エラー): ${message.slice(0, 200)}`, false);
  }
  if (status === 404) return new OcrError(`モデル「${model}」が見つかりません。設定の「接続テスト」で選び直してください`, false);
  if (status === 429) return new OcrError("無料枠の利用上限に達しました", false, 0, true);
  if (status >= 500) return new OcrError(`Gemini 側のエラー (${status})。しばらくして再試行してください`, true, 5_000);
  return new OcrError(`Gemini API エラー (${status}): ${message.slice(0, 300)}`, false);
}
