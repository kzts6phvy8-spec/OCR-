import path from "node:path";

const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");

export const config = {
  port: Number(process.env.PORT ?? 3001),
  dataDir,
  uploadDir: path.join(dataDir, "uploads"),
  dbPath: path.join(dataDir, "warlords.db"),
  model: process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5",
  effort: (process.env.CLAUDE_EFFORT ?? "low") as "low" | "medium" | "high",
  timeoutMs: Number(process.env.CLAUDE_TIMEOUT_MS ?? 45_000),
  maxRetries: Number(process.env.CLAUDE_MAX_RETRIES ?? 2),
  /** 拒否 (refusal) 時のサーバー側フォールバック。プロキシ経由などで使えない場合は off */
  fallbacks: (process.env.CLAUDE_FALLBACKS ?? "on") !== "off",
  maxUploadBytes: 15 * 1024 * 1024,
  isProduction: process.env.NODE_ENV === "production",
};

export const hasApiKey = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
