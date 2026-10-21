import type { Settings } from "./settings.ts";

// バックグラウンド解析サーバー (利用者の Google アカウントで動く Apps Script) との通信。
// 本文を text/plain で送ると事前確認 (CORS プリフライト) が不要になり、Apps Script でも受け取れる。

export interface ServerCounts {
  /** サーバーで解析待ちの枚数 */
  pending: number;
  /** 解析済みでアプリの受け取り待ちの枚数 */
  ready: number;
}

export interface RemoteResult {
  id: string;
  ok: boolean;
  status: number;
  body?: string;
  error?: string;
}

export class ServerError extends Error {}

export async function callServer<T = Record<string, unknown>>(
  settings: Settings,
  action: "config" | "enqueue" | "results" | "ack" | "cancel" | "status" | "kick",
  payload: Record<string, unknown> = {},
): Promise<T & { ok: true } & Partial<ServerCounts>> {
  if (!settings.bgUrl) throw new ServerError("サーバーの URL が未設定です");
  let res: Response;
  try {
    res = await fetch(settings.bgUrl, {
      method: "POST",
      body: JSON.stringify({ action, token: settings.bgToken, ...payload }),
      redirect: "follow",
    });
  } catch {
    throw new ServerError("サーバーに接続できませんでした (URL と電波状況を確認してください)");
  }
  const text = await res.text();
  let json: { ok?: boolean; error?: string };
  try {
    json = JSON.parse(text);
  } catch {
    throw new ServerError(
      /<html/i.test(text)
        ? "サーバーの応答がウェブページでした。デプロイの「アクセスできるユーザー」が「全員」になっているか確認してください"
        : `サーバーの応答を読み取れませんでした (${res.status})`,
    );
  }
  if (!json.ok) throw new ServerError(json.error ?? "サーバーでエラーが発生しました");
  return json as T & { ok: true } & Partial<ServerCounts>;
}
