import { ApiError, GoogleGenAI } from "@google/genai";
import { z } from "zod";
import type { UploadMode } from "../../core/types.ts";
import { OcrExtractionSchema, type OcrExtraction } from "../../core/ocrSchema.ts";
import { SYSTEM_PROMPT } from "../../core/prompt.ts";
import { blobToBase64 } from "./images.ts";
import { OcrError, modeHint } from "./ocrCommon.ts";
import type { Settings } from "./settings.ts";

// Google Gemini API (無料枠あり) で読み取る。Claude 版と同じスキーマ・指示文を使う。

const TIMEOUT_MS = 45_000;

/** Gemini に渡す JSON Schema (Claude と同じ Zod スキーマから生成) */
const RESPONSE_SCHEMA = (() => {
  const s = z.toJSONSchema(OcrExtractionSchema) as Record<string, unknown>;
  delete s.$schema;
  return s;
})();

function client(settings: Settings) {
  return new GoogleGenAI({ apiKey: settings.geminiKey, httpOptions: { timeout: TIMEOUT_MS } });
}

function toOcrError(err: unknown, settings: Settings): OcrError {
  if (err instanceof OcrError) return err;
  if (err instanceof ApiError) {
    const msg = err.message ?? "";
    if (err.status === 400 && /API_KEY_INVALID|API key not valid/i.test(msg)) {
      return new OcrError("Gemini の API キーが無効です。設定画面で確認してください", false);
    }
    if (err.status === 403) return new OcrError("この API キーでは Gemini を利用できません (権限エラー)", false);
    if (err.status === 404) return new OcrError(`モデル「${settings.geminiModel}」が見つかりません。設定の「接続テスト」で選び直してください`, false);
    if (err.status === 429) return new OcrError("無料枠の利用上限に達しました。時間をおいて再試行してください", true, 30_000);
    if (err.status >= 500) return new OcrError(`Gemini 側のエラー (${err.status})。しばらくして再試行してください`, true, 5_000);
    return new OcrError(`Gemini API エラー (${err.status}): ${msg}`, false);
  }
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
            { text: `このスクリーンショットから武将情報を読み取り、JSON で返してください。${modeHint(mode)}` },
          ],
        },
      ],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: "application/json",
        responseJsonSchema: RESPONSE_SCHEMA,
        temperature: 0,
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
