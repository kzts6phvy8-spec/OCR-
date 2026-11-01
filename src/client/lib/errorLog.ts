// アプリで起きたエラーの記録 (端末内に最新 100 件)。「データ管理」の点検結果と一緒にコピーして送れるようにする。

const KEY = "sengoku-fubu-error-log";
const MAX = 100;

export interface ErrorEntry {
  at: string;
  where: string;
  message: string;
}

export function getErrorLog(): ErrorEntry[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as ErrorEntry[];
  } catch {
    return [];
  }
}

export function logError(where: string, message: string) {
  try {
    const log = getErrorLog();
    const last = log[log.length - 1];
    if (last && last.where === where && last.message === message) return; // 同じエラーの連続は 1 件に
    log.push({ at: new Date().toISOString(), where, message: message.slice(0, 500) });
    localStorage.setItem(KEY, JSON.stringify(log.slice(-MAX)));
  } catch {
    /* 記録できなくてもアプリは動く */
  }
}

export function clearErrorLog() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 消せなくても困らない */
  }
}

/** 予期しないエラーを記録する (アプリ起動時に 1 回呼ぶ) */
export function installErrorLogging() {
  if (typeof window === "undefined") return;
  window.addEventListener("error", (e) => logError("画面", `${e.message} (${e.filename?.split("/").pop() ?? ""}:${e.lineno})`));
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason as unknown;
    logError("処理", r instanceof Error ? `${r.name}: ${r.message}` : String(r));
  });
}
