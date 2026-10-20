// 設定は端末のブラウザ (localStorage) にだけ保存する。API キーが外部に送られるのは各 AI への通信時のみ。

export type Provider = "gemini" | "claude";

export interface Settings {
  provider: Provider;
  /** Gemini (Google) */
  geminiKey: string;
  geminiModel: string;
  /** 接続テストで取得した、使えるモデルの一覧 */
  geminiModels: string[];
  /** Claude (Anthropic) */
  apiKey: string;
  model: string;
  effort: "low" | "medium" | "high";
}

export const CLAUDE_MODELS = [
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5 (標準)", note: "1 枚あたり約 2〜4 円" },
  { id: "claude-opus-5-5", label: "Opus 5.5 (高精度)", note: "1 枚あたり約 4〜8 円" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5 (最安)", note: "1 枚あたり 1 円未満" },
] as const;

/** Google が常に最新の Flash モデルを指すように用意している名前 */
export const DEFAULT_GEMINI_MODEL = "gemini-flash-latest";

const KEY = "sengoku-fubu-settings";
const DEFAULTS: Settings = {
  provider: "gemini",
  geminiKey: "",
  geminiModel: DEFAULT_GEMINI_MODEL,
  geminiModels: [],
  apiKey: "",
  model: "claude-sonnet-5-5",
  effort: "low",
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const saved = JSON.parse(raw) as Partial<Settings>;
    // 以前の版 (Claude のみ) で Claude のキーを登録済みなら Claude のまま使う
    const provider = saved.provider ?? (saved.apiKey ? "claude" : "gemini");
    return { ...DEFAULTS, ...saved, provider };
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

/** 選択中の AI のキーが登録されているか */
export const hasActiveKey = (s: Settings) => Boolean(s.provider === "claude" ? s.apiKey : s.geminiKey);

/** 画面表示用: 選択中の AI とモデル */
export const activeModelLabel = (s: Settings) => (s.provider === "claude" ? `Claude / ${s.model}` : `Gemini / ${s.geminiModel}`);

const listeners = new Set<(s: Settings) => void>();
export function onSettingsChange(fn: (s: Settings) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
