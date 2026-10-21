import type { UploadMode } from "../../core/types.ts";

export class OcrError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /** 再試行までの待ち時間 (ミリ秒) */
    readonly retryAfterMs = 1500,
    /** 利用回数の上限 (無料枠など) に達した: キュー全体を一時停止して待つ */
    readonly rateLimited = false,
    /** 1 日の上限に達した (翌日の上限が戻る時刻まで待つ) */
    readonly dailyLimit = false,
  ) {
    super(message);
  }
}

export function modeHint(mode: UploadMode): string {
  if (mode === "force_normal") return "\n(ユーザー指定: この画像は通常武将です)";
  if (mode === "force_special") return "\n(ユーザー指定: この画像は特異武将です)";
  return "";
}
