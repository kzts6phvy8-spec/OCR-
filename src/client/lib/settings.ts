// 設定は端末のブラウザ (localStorage) にだけ保存する。API キーが外部に送られるのは Anthropic への通信時のみ。

export interface Settings {
  apiKey: string;
  model: string;
  effort: "low" | "medium" | "high";
}

export const MODELS = [
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5 (標準・おすすめ)", note: "1 枚あたり約 2〜4 円" },
  { id: "claude-opus-5-5", label: "Opus 5.5 (高精度)", note: "1 枚あたり約 4〜8 円" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5 (最安・精度は低め)", note: "1 枚あたり 1 円未満" },
] as const;

const KEY = "sengoku-fubu-settings";
const DEFAULTS: Settings = { apiKey: "", model: "claude-sonnet-5-5", effort: "low" };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* プライベートブラウズ等で保存できない場合は無視 */
  }
  listeners.forEach((fn) => fn(s));
}

const listeners = new Set<(s: Settings) => void>();
export function onSettingsChange(fn: (s: Settings) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
