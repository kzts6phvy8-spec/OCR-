import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";

// Google Apps Script のサーバーコード (public/apps-script.txt) を、Google のサービスを模したものの上で動かして確かめる

type File = { name: string; content: string; trashed: boolean };

function makeEnv(
  fetchImpl: (req: { url: string; payload: string; headers: Record<string, string> }) => { code: number; text: string },
  /** ドライブの呼び出しを失敗させる回数 (ドライブの一時的な不調を再現) */
  driveFailures = { left: 0 },
) {
  const flaky = () => {
    if (driveFailures.left > 0) {
      driveFailures.left--;
      throw new Error("サービス エラー: ドライブ");
    }
  };
  const files: File[] = [];
  const props = new Map<string, string>();
  const triggers: string[] = [];
  const live = () => files.filter((f) => !f.trashed);
  const fileApi = (f: File) => ({
    getName: () => f.name,
    isTrashed: () => f.trashed,
    getBlob: () => ({ getDataAsString: () => f.content }),
    setContent: (c: string) => void (f.content = c),
    setTrashed: (t: boolean) => void (f.trashed = t),
  });
  const iter = <T,>(arr: T[]) => {
    let i = 0;
    return { hasNext: () => i < arr.length, next: () => arr[i++] };
  };
  const folder = {
    getId: () => "folder-1",
    getFiles: () => (flaky(), iter(live().map(fileApi))),
    // 本物のドライブの検索は新しいファイルや記号入りの名前を見つけられないことがあるので、使ったら何も返さない
    searchFiles: () => iter([]),
    getFilesByName: (n: string) => iter(live().filter((f) => f.name === n).map(fileApi)),
    createFile: (name: string, content: string) => {
      files.push({ name, content, trashed: false });
    },
  };
  let folderCreated = false;
  const ctx = {
    DriveApp: {
      getFolderById: () => (flaky(), folder),
      getFoldersByName: () => iter(folderCreated ? [folder] : []),
      createFolder: () => ((folderCreated = true), folder),
    },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: (k: string) => props.get(k) ?? null, setProperty: (k: string, v: string) => props.set(k, v), deleteProperty: (k: string) => props.delete(k) }),
    },
    ScriptApp: {
      getProjectTriggers: () => triggers.map((h) => ({ getHandlerFunction: () => h })),
      newTrigger: (h: string) => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => triggers.push(h) }) }) }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    UrlFetchApp: {
      fetchAll: (reqs: { url: string; payload: string; headers: Record<string, string> }[]) =>
        reqs.map((r) => {
          const res = fetchImpl(r);
          return { getResponseCode: () => res.code, getContentText: () => res.text };
        }),
    },
    ContentService: {
      MimeType: { JSON: "json" },
      createTextOutput: (t: string) => ({ setMimeType: () => ({ body: t }) }),
    },
    Logger: { log: () => {} },
    Utilities: { sleep: () => {} },
  } as Record<string, unknown>;
  runInNewContext(readFileSync("public/apps-script.txt", "utf8"), ctx);
  const post = (body: object) => JSON.parse((ctx.doPost as (e: unknown) => { body: string })({ postData: { contents: JSON.stringify(body) } }).body);
  return { ctx, post, files, props, triggers, driveFailures, process: () => (ctx.processQueue as () => void)() };
}

const TOKEN = "t".repeat(32);

describe("バックグラウンド解析サーバー (Apps Script)", () => {
  let calls: { url: string; payload: string; headers: Record<string, string> }[];
  let reply: () => { code: number; text: string };
  let env: ReturnType<typeof makeEnv>;

  beforeEach(() => {
    calls = [];
    reply = () => ({ code: 200, text: '{"candidates":[]}' });
    env = makeEnv((r) => (calls.push(r), reply()));
  });

  it("最初の接続で合言葉とキーを登録し、1 分ごとの起動を設定する。以後は合言葉が違えば拒否", () => {
    expect(env.post({ action: "status", token: TOKEN }).ok).toBe(false);
    expect(env.post({ action: "config", token: TOKEN, geminiKey: "AQ.key" })).toMatchObject({ ok: true, pending: 0 });
    expect(env.props.get("GEMINI_KEY")).toBe("AQ.key");
    expect(env.triggers).toEqual(["processQueue"]);
    expect(env.post({ action: "config", token: TOKEN })).toMatchObject({ ok: true });
    expect(env.triggers).toHaveLength(1);
    expect(env.post({ action: "status", token: "x".repeat(32) })).toMatchObject({ ok: false });
  });

  it("依頼を受けて解析し、結果を返して、受け取り後に消す", () => {
    env.post({ action: "config", token: TOKEN, geminiKey: "AQ.key" });
    for (const id of ["a", "b", "c", "d", "e"]) {
      expect(env.post({ action: "enqueue", token: TOKEN, id, model: "gemini-flash-latest", body: { contents: [id] } }).ok).toBe(true);
    }
    env.post({ action: "enqueue", token: TOKEN, id: "a", model: "gemini-flash-latest", body: {} }); // 重複は無視
    expect(env.post({ action: "status", token: TOKEN })).toMatchObject({ pending: 5, ready: 0 });

    env.process();
    expect(calls).toHaveLength(5);
    expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent");
    expect(calls[0].headers["x-goog-api-key"]).toBe("AQ.key");
    expect(JSON.parse(calls[0].payload)).toEqual({ contents: ["a"] });

    const res = env.post({ action: "results", token: TOKEN });
    expect(res.results.map((r: { id: string }) => r.id).sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(res.results[0]).toMatchObject({ ok: true, status: 200, body: '{"candidates":[]}' });
    expect(res).toMatchObject({ pending: 0, ready: 5 });

    env.post({ action: "ack", token: TOKEN, ids: ["a", "b"] });
    expect(env.post({ action: "status", token: TOKEN })).toMatchObject({ ready: 3 });
  });

  it("無料枠の上限 (429) では依頼を残して次の起動を待ち、上限の種類をアプリに伝える", () => {
    env.post({ action: "config", token: TOKEN, geminiKey: "AQ.key" });
    env.post({ action: "enqueue", token: TOKEN, id: "a", model: "m", body: {} });
    reply = () => ({ code: 429, text: '{"error":{"message":"Quota exceeded for metric: generate_content_free_tier_requests, limit: 250, GenerateRequestsPerDayPerProjectPerModel-FreeTier"}}' });
    env.process();
    const st = env.post({ action: "status", token: TOKEN });
    expect(st).toMatchObject({ pending: 1, ready: 0, version: 5 });
    expect(st.limit).toMatchObject({ daily: true });
    expect(st.lastRunAt).toBeGreaterThan(0);
    expect(st.lastOkAt).toBe(0);
    reply = () => ({ code: 200, text: "{}" });
    env.process();
    const st2 = env.post({ action: "status", token: TOKEN });
    expect(st2).toMatchObject({ pending: 0, ready: 1, limit: null });
    expect(st2.lastOkAt).toBeGreaterThan(0);
  });

  it("1 分あたりの上限は daily: false として伝える", () => {
    env.post({ action: "config", token: TOKEN, geminiKey: "AQ.key" });
    env.post({ action: "enqueue", token: TOKEN, id: "a", model: "m", body: {} });
    reply = () => ({ code: 429, text: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" });
    env.process();
    expect(env.post({ action: "status", token: TOKEN }).limit).toMatchObject({ daily: false });
  });

  it("サーバーエラーは数回まで再試行し、それ以外のエラーは結果として返す", () => {
    env.post({ action: "config", token: TOKEN, geminiKey: "AQ.key" });
    env.post({ action: "enqueue", token: TOKEN, id: "a", model: "m", body: {} });
    reply = () => ({ code: 503, text: "busy" });
    env.process(); // 1 回目: 失敗 → 依頼を残す
    expect(env.post({ action: "status", token: TOKEN })).toMatchObject({ pending: 1, ready: 0 });
    env.process(); // 次の起動で再試行
    env.process(); // 上限回数で結果になる
    const res = env.post({ action: "results", token: TOKEN });
    expect(res.results).toEqual([{ id: "a", ok: false, status: 503, error: "busy" }]);
    expect(calls.length).toBe(3);
  });

  it("kick の合図で、自動起動を待たずにその場で解析する", () => {
    env.post({ action: "config", token: TOKEN, geminiKey: "AQ.key" });
    for (let i = 0; i < 10; i++) env.post({ action: "enqueue", token: TOKEN, id: "k" + i, model: "m", body: {} });
    expect(env.post({ action: "kick", token: TOKEN })).toMatchObject({ ok: true, version: 5, pending: 0, ready: 10 });
    expect(calls).toHaveLength(10);
    expect(env.post({ action: "results", token: TOKEN }).version).toBe(5);
  });

  it("ドライブが一時的にエラーを返しても、やり直して解析を続ける", () => {
    env.post({ action: "config", token: TOKEN, geminiKey: "AQ.key" });
    for (const id of ["a", "b"]) env.post({ action: "enqueue", token: TOKEN, id, model: "m", body: {} });
    env.driveFailures.left = 2; // 2 回続けて失敗 → 3 回目で成功
    env.process();
    expect(calls).toHaveLength(2);
    expect(env.post({ action: "status", token: TOKEN })).toMatchObject({ pending: 0, ready: 2, lastError: null });
  });

  it("ドライブの不調が続いても止まらずに記録だけ残し、直れば次の起動で続きから", () => {
    env.post({ action: "config", token: TOKEN, geminiKey: "AQ.key" });
    env.post({ action: "enqueue", token: TOKEN, id: "a", model: "m", body: {} });
    env.driveFailures.left = 1000;
    expect(() => env.process()).not.toThrow();
    env.driveFailures.left = 0;
    const st = env.post({ action: "status", token: TOKEN });
    expect(st.lastError.message).toContain("ドライブ");
    expect(st.pending).toBe(1);
    env.process();
    expect(calls).toHaveLength(1);
    expect(env.post({ action: "status", token: TOKEN })).toMatchObject({ pending: 0, ready: 1, lastError: null });
  });

  it("ドライブが不調な時の問い合わせには、分かりやすいエラーを返す", () => {
    env.post({ action: "config", token: TOKEN, geminiKey: "AQ.key" });
    env.driveFailures.left = 1000;
    const res = env.post({ action: "enqueue", token: TOKEN, id: "a", model: "m", body: {} });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Google ドライブが一時的に使えません");
  });

  it("取り消した依頼は解析しない", () => {
    env.post({ action: "config", token: TOKEN, geminiKey: "AQ.key" });
    env.post({ action: "enqueue", token: TOKEN, id: "a", model: "m", body: {} });
    env.post({ action: "cancel", token: TOKEN, ids: ["a"] });
    env.process();
    expect(calls).toHaveLength(0);
  });
});
