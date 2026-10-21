import type { OcrJob } from "../../core/types.ts";
import { isDailyLimit } from "./quota.ts";
import type { Settings } from "./settings.ts";

// サーバーから理由が届かない (版 2 以前の) 場合に、アプリから Gemini へ小さな問い合わせを 1 回送り、
// 無料枠の上限に達しているかを確かめる。止まっている時だけ、30 分に 1 回まで。

export interface ProbeResult {
  at: number;
  /** limit: 上限に達している / ok: 上限には余裕がある / error: 確かめられなかった */
  status: "limit" | "ok" | "error";
  daily?: boolean;
  message?: string;
}

const KEY = "gemini-quota-probe";
const INTERVAL_MS = 30 * 60_000;
/** この時間、新しい結果が届かなければ「止まっている」とみなす */
export const STALL_MS = 10 * 60_000;

export function lastProbe(): ProbeResult | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ProbeResult) : null;
  } catch {
    return null;
  }
}

function save(r: ProbeResult) {
  try {
    localStorage.setItem(KEY, JSON.stringify(r));
  } catch {
    /* 保存できなくても、この回の表示には使える */
  }
}

/** サーバーで解析待ちのジョブがあるのに、しばらく結果が届いていないか */
export function isStalled(jobs: OcrJob[], lastResultAt: number, now = Date.now()) {
  const remote = jobs.filter((j) => j.status === "remote");
  if (remote.length === 0) return false;
  const oldest = Math.min(...remote.map((j) => Date.parse(j.updated_at)));
  // アプリを開き直した直後でも分かるよう、最後に図鑑へ反映した時刻も「進んでいた時刻」として数える
  const lastDone = Math.max(0, ...jobs.filter((j) => j.status === "done").map((j) => Date.parse(j.updated_at)));
  return now - Math.max(lastResultAt, oldest, lastDone) > STALL_MS;
}

/** 必要なら Gemini に確認の問い合わせを送る。送らなかった時は前回の結果を返す */
export async function probeIfNeeded(settings: Settings, now = Date.now()): Promise<ProbeResult | null> {
  const prev = lastProbe();
  if (prev && now - prev.at < INTERVAL_MS) return prev;
  if (!settings.geminiKey) return prev;
  let result: ProbeResult;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.geminiModel)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": settings.geminiKey },
        // できるだけ小さな問い合わせ (返事も短く)
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "OK と返してください" }] }], generationConfig: { maxOutputTokens: 16 } }),
      },
    );
    const text = await res.text();
    if (res.status === 429) result = { at: now, status: "limit", daily: isDailyLimit(text), message: text.slice(0, 300) };
    else if (res.ok) result = { at: now, status: "ok" };
    else result = { at: now, status: "error", message: `${res.status}: ${text.slice(0, 200)}` };
  } catch {
    result = { at: now, status: "error", message: "通信できませんでした" };
  }
  save(result);
  return result;
}
