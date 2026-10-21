import { ApiError, GoogleGenAI, MediaResolution, ThinkingLevel } from "@google/genai";
import type { UploadMode } from "../../core/types.ts";
import type { OcrExtraction } from "../../core/ocrSchema.ts";
import { SYSTEM_PROMPT } from "../../core/prompt.ts";
import { RESPONSE_SCHEMA, geminiHttpError, parseExtractionText, thinkingLevelAllowed, userText } from "./geminiShared.ts";
import { blobToBase64 } from "./images.ts";
import { OcrError } from "./ocrCommon.ts";
import type { Settings } from "./settings.ts";

// Google Gemini API (無料枠あり) で読み取る。Claude 版と同じスキーマ・指示文を使う。

const TIMEOUT_MS = 45_000;

function client(settings: Settings) {
  return new GoogleGenAI({ apiKey: settings.geminiKey, httpOptions: { timeout: TIMEOUT_MS } });
}

function toOcrError(err: unknown, settings: Settings): OcrError {
  if (err instanceof OcrError) return err;
  if (err instanceof ApiError) return geminiHttpError(err.status, err.message ?? "", settings.geminiModel);
  if (err instanceof Error && /abort|timeout/i.test(`${err.name} ${err.message}`)) {
    return new OcrError(`AI の応答がタイムアウトしました (${TIMEOUT_MS / 1000} 秒)`, true, 2_000);
  }
  if (err instanceof TypeError) return new OcrError("通信できませんでした。電波状況を確認してください", true, 3_000);
  return new OcrError(err instanceof Error ? err.message : String(err), false);
}

export async function analyzeScreenshot(image: Blob, mode: UploadMode, settings: Settings): Promise<OcrExtraction> {
  if (!settings.geminiKey) throw new OcrError("Gemini の API キーが未設定です。「設定」から登録してください", false);
  const data = await blobToBase64(image);
  let text: string | undefined;
  try {
    const res = await client(settings).models.generateContent({
      model: settings.geminiModel,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/jpeg", data } },
            { text: userText(mode) },
          ],
        },
      ],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: "application/json",
        responseJsonSchema: RESPONSE_SCHEMA,
        // 小さな文字まで読めるよう、画像を高解像度で解析させる
        mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH,
        temperature: 0,
        // 文字を書き写すだけなので「考える時間」を短くして速度を優先 (未対応モデルなら自動で外す)
        ...(thinkingLevelAllowed() ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}),
      },
    });
    const finish = res.candidates?.[0]?.finishReason;
    if (finish === "SAFETY" || finish === "PROHIBITED_CONTENT" || res.promptFeedback?.blockReason) {
      throw new OcrError("AI が解析を拒否しました (安全フィルタ)", false);
    }
    if (finish === "MAX_TOKENS") throw new OcrError("AI の出力が上限で途切れました", true);
    text = res.text;
  } catch (err) {
    throw toOcrError(err, settings);
  }

  // 形式が崩れた応答は採用せず、再試行に回す
  return parseExtractionText(text);
}

/** API キーの確認と、画像解析に使えるモデルの一覧取得 (料金はかからない) */
export async function testConnection(settings: Settings): Promise<string[]> {
  try {
    const pager = await client(settings).models.list({ config: { pageSize: 100 } });
    const names: string[] = [];
    for await (const m of pager) {
      const id = (m.name ?? "").replace(/^models\//, "");
      if (!id || (m.supportedActions && !m.supportedActions.includes("generateContent"))) continue;
      if (!/gemini/i.test(id) || /embedding|tts|image-generation|live|audio/i.test(id)) continue;
      names.push(id);
    }
    return names;
  } catch (err) {
    throw toOcrError(err, settings);
  }
}
