import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";

// Google Apps Script のサーバーコード (public/apps-script.gs) を、Google のサービスを模したものの上で動かして確かめる

type File = { name: string; content: string; trashed: boolean };

function makeEnv(fetchImpl: (req: { url: string; payload: string; headers: Record<string, string> }) => { code: number; text: string }) {
  const files: File[] = [];
  const props = new Map<string, string>();
  const triggers: string[] = [];
  const live = () => files.filter((f) => !f.trashed);
  const fileApi = (f: File) => ({
    getName: () => f.name,
    getBlob: () => ({ getDataAsString: () => f.content }),
    setContent: (c: string) => void (f.content = c),
    setTrashed: (t: boolean) => void (f.trashed = t),
  });
  const iter = <T,>(arr: T[]) => {
    let i = 0;
    return { hasNext: () => i < arr.length, next: () => arr[i++] };
  };
  const folder = {
    getFiles: () => iter(live().map(fileApi)),
    getFilesByName: (n: string) => iter(live().filter((f) => f.name === n).map(fileApi)),
    createFile: (name: string, content: string) => {
      files.push({ name, content, trashed: false });
    },
  };
  let folderCreated = false;
  const ctx = {
    DriveApp: {
      getFoldersByName: () => iter(folderCreated ? [folder] : []),
      createFolder: () => ((folderCreated = true), folder),
    },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: (k: string) => props.get(k) ?? null, setProperty: (k: string, v: string) => props.set(k, v) }),
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
  } as Record<string, unknown>;
  runInNewContext(readFileSync("public/apps-script.gs", "utf8"), ctx);
  const post = (body: object) => JSON.parse((ctx.doPost as (e: unknown) => { body: string })({ postData: { contents: JSON.stringify(body) } }).body);
  return { ctx, post, files, props, triggers, process: () => (ctx.processQueue as () => void)() };
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

  it("無料枠の上限 (429) では依頼を残して次の起動を待つ", () => {
    env.post({ action: "config", token: TOKEN, geminiKey: "AQ.key" });
    env.post({ action: "enqueue", token: TOKEN, id: "a", model: "m", body: {} });
    reply = () => ({ code: 429, text: "quota" });
    env.process();
    expect(env.post({ action: "status", token: TOKEN })).toMatchObject({ pending: 1, ready: 0 });
    reply = () => ({ code: 200, text: "{}" });
    env.process();
    expect(env.post({ action: "status", token: TOKEN })).toMatchObject({ pending: 0, ready: 1 });
  });

  it("サーバーエラーは数回まで再試行し、それ以外のエラーは結果として返す", () => {
    env.post({ action: "config", token: TOKEN, geminiKey: "AQ.key" });
    env.post({ action: "enqueue", token: TOKEN, id: "a", model: "m", body: {} });
    reply = () => ({ code: 503, text: "busy" });
    env.process(); // 1 回の起動の中でも再試行して、上限回数で結果になる
    const res = env.post({ action: "results", token: TOKEN });
    expect(res.results).toEqual([{ id: "a", ok: false, status: 503, error: "busy" }]);
    expect(calls.length).toBe(3);
  });

  it("取り消した依頼は解析しない", () => {
    env.post({ action: "config", token: TOKEN, geminiKey: "AQ.key" });
    env.post({ action: "enqueue", token: TOKEN, id: "a", model: "m", body: {} });
    env.post({ action: "cancel", token: TOKEN, ids: ["a"] });
    env.process();
    expect(calls).toHaveLength(0);
  });
});
