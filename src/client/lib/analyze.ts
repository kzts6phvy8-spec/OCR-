import type { UploadMode } from "../../core/types.ts";
import type { OcrExtraction } from "../../core/ocrSchema.ts";
import { OcrError } from "./ocrCommon.ts";
import type { Settings } from "./settings.ts";

// 設定で選んだ AI (Gemini / Claude) で 1 枚を読み取る。AI 通信部分は大きいので必要になった時だけ読み込む。

async function analyzeOnce(image: Blob, mode: UploadMode, settings: Settings): Promise<OcrExtraction> {
  const mod = settings.provider === "claude" ? await import("./ocr.ts") : await import("./gemini.ts");
  return mod.analyzeScreenshot(image, mode, settings);
}

/** 形式崩れ・一時的なエラー (無料枠の回数制限など) は待ってから再試行する */
export async function analyzeWithRetry(image: Blob, mode: UploadMode, settings: Settings, attempts = 3) {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await analyzeOnce(image, mode, settings);
    } catch (err) {
      lastError = err;
      if (!(err instanceof OcrError) || !err.retryable || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, err.retryAfterMs * (i + 1)));
    }
  }
  throw lastError;
}
