// Gemini 無料枠の上限に関する表示用の補助

/** 429 の本文から「1 日の上限」かどうかを判定する */
export const isDailyLimit = (message: string) => /per.?day|PerDay|daily/i.test(message);

/**
 * Gemini API の 1 日の上限が戻る時刻 (太平洋時間の 0 時 = 日本時間の 16 時か 17 時)。
 * 夏時間を考慮するため、太平洋時間の現在時刻から次の 0 時までの時間を求める。
 */
export function nextDailyReset(now = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const sinceMidnight = (get("hour") * 3600 + get("minute") * 60 + get("second")) * 1000;
  return new Date(now.getTime() + 24 * 3600 * 1000 - sinceMidnight);
}

export const formatClock = (d: Date | number) =>
  new Date(d).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });

/** 「明日の 16:00」のような表示 */
export function formatReset(d: Date, now = new Date()): string {
  const sameDay = d.toDateString() === now.toDateString();
  return `${sameDay ? "今日" : "明日"}の ${formatClock(d)} ごろ`;
}
