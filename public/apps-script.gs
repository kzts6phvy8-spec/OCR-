/**
 * 戦国布武 武将図鑑 — バックグラウンド解析サーバー (Google Apps Script)
 *
 * iPhone のアプリを閉じている間も、Google のサーバー上でスクリーンショットを解析します。
 * - アプリから送られた解析依頼 (画像入り) を Google ドライブの「武将図鑑_解析キュー」フォルダに置く
 * - 1 分ごとに起動して Gemini API に送り、結果を同じフォルダに保存する
 * - アプリを開くと結果を受け取り、受け取った結果は削除する
 *
 * 指示文・モデル・設定はアプリ側から毎回送られるので、このコードを更新する必要はありません。
 * Gemini の API キーと合言葉は、アプリの「接続テスト」で自動的に登録されます。
 */

const VERSION = 3;
const FOLDER_NAME = "武将図鑑_解析キュー";
const BATCH = 8; // 1 回の問い合わせで同時に送る枚数
const MAX_RUN_MS = 4.5 * 60 * 1000; // 1 回の起動で使う最大時間 (上限 6 分)
const MAX_ATTEMPTS = 3; // サーバーエラー時の再試行回数

// ---------------- アプリからの呼び出し ----------------

function doGet() {
  return json({ ok: true, app: "sengoku-fubu-bg", version: VERSION });
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const props = PropertiesService.getScriptProperties();

    // 最初に接続したアプリの合言葉を登録し、以後は一致する時だけ受け付ける
    const saved = props.getProperty("TOKEN");
    if (!req.token || String(req.token).length < 16) return json({ ok: false, error: "合言葉がありません" });
    if (!saved) {
      if (req.action !== "config") return json({ ok: false, error: "先にアプリで接続テストをしてください" });
      props.setProperty("TOKEN", req.token);
    } else if (saved !== req.token) {
      return json({ ok: false, error: "合言葉が一致しません (別の端末から登録済みです)" });
    }

    switch (req.action) {
      case "config":
        if (req.geminiKey) props.setProperty("GEMINI_KEY", req.geminiKey);
        ensureTrigger();
        return json({ ok: true, version: VERSION, ...counts() });
      case "enqueue":
        return json(enqueue(req));
      case "results":
        return json({ ok: true, version: VERSION, results: takeResults(req.limit || 50), ...counts() });
      case "ack":
        trashByIds(req.ids || [], "result_");
        return json({ ok: true });
      case "cancel":
        trashByIds(req.ids || [], "job_");
        return json({ ok: true });
      case "status":
        return json({ ok: true, version: VERSION, ...counts() });
      case "kick":
        // アプリからの「すぐ解析を始めて」の合図。1 分ごとの自動起動を待たずに解析する
        // (ウェブアプリとしての実行は、自動起動の 1 日の実行時間の上限にも数えられない)
        processQueue();
        return json({ ok: true, version: VERSION, ...counts() });
      default:
        return json({ ok: false, error: "不明な操作です: " + req.action });
    }
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function enqueue(req) {
  if (!req.id || !req.model || !req.body) return { ok: false, error: "依頼の内容が足りません" };
  const folder = getFolder();
  const name = "job_" + req.id + ".json";
  if (!folder.getFilesByName(name).hasNext()) {
    folder.createFile(name, JSON.stringify({ id: req.id, model: req.model, body: req.body, attempts: 0 }), "application/json");
  }
  return { ok: true };
}

function takeResults(limit) {
  const out = [];
  const files = getFolder().getFiles();
  while (files.hasNext() && out.length < limit) {
    const f = files.next();
    if (f.getName().indexOf("result_") !== 0) continue;
    try {
      out.push(JSON.parse(f.getBlob().getDataAsString()));
    } catch (err) {
      f.setTrashed(true);
    }
  }
  return out;
}

function trashByIds(ids, prefix) {
  const folder = getFolder();
  ids.forEach(function (id) {
    const it = folder.getFilesByName(prefix + id + ".json");
    while (it.hasNext()) it.next().setTrashed(true);
  });
}

function counts() {
  let pending = 0;
  let ready = 0;
  const files = getFolder().getFiles();
  while (files.hasNext()) {
    const n = files.next().getName();
    if (n.indexOf("job_") === 0) pending++;
    else if (n.indexOf("result_") === 0) ready++;
  }
  // pending: 解析待ち / ready: 解析済みで受け取り待ち
  // lastRunAt / lastOkAt: 最後に解析を試みた・成功した時刻、limit: 無料枠などの上限に達している時の情報
  const props = PropertiesService.getScriptProperties();
  const limit = props.getProperty("LAST_LIMIT");
  return {
    pending: pending,
    ready: ready,
    lastRunAt: Number(props.getProperty("LAST_RUN") || 0),
    lastOkAt: Number(props.getProperty("LAST_OK") || 0),
    limit: limit ? JSON.parse(limit) : null,
  };
}

// ---------------- 1 分ごとの解析 ----------------

function processQueue() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // 前回の処理がまだ動いている
  try {
    const props = PropertiesService.getScriptProperties();
    const key = props.getProperty("GEMINI_KEY");
    if (!key) return;
    const started = Date.now();
    const folder = getFolder();
    while (Date.now() - started < MAX_RUN_MS) {
      const jobs = [];
      const files = folder.getFiles();
      while (files.hasNext() && jobs.length < BATCH) {
        const f = files.next();
        if (f.getName().indexOf("job_") !== 0) continue;
        try {
          jobs.push({ file: f, job: JSON.parse(f.getBlob().getDataAsString()) });
        } catch (err) {
          f.setTrashed(true);
        }
      }
      if (jobs.length === 0) return;
      props.setProperty("LAST_RUN", String(Date.now()));

      const responses = UrlFetchApp.fetchAll(
        jobs.map(function (j) {
          return {
            url: "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(j.job.model) + ":generateContent",
            method: "post",
            contentType: "application/json",
            headers: { "x-goog-api-key": key },
            payload: JSON.stringify(j.job.body),
            muteHttpExceptions: true,
          };
        }),
      );

      let rateLimited = false;
      responses.forEach(function (res, i) {
        const j = jobs[i];
        const code = res.getResponseCode();
        const text = res.getContentText();
        if (code === 200) {
          props.setProperty("LAST_OK", String(Date.now()));
          props.deleteProperty("LAST_LIMIT");
          return finish(folder, j, { id: j.job.id, ok: true, status: code, body: text });
        }
        if (code === 429) {
          rateLimited = true; // 無料枠の上限: 依頼はそのまま残し、次の起動で再挑戦
          // アプリに「上限に達している」ことと、1 日の上限か 1 分の上限かを伝えるために記録する
          props.setProperty(
            "LAST_LIMIT",
            JSON.stringify({ at: Date.now(), daily: /per.?day|PerDay|daily/i.test(text), message: text.slice(0, 500) }),
          );
          return;
        }
        if (code >= 500 && (j.job.attempts || 0) + 1 < MAX_ATTEMPTS) {
          j.job.attempts = (j.job.attempts || 0) + 1;
          j.file.setContent(JSON.stringify(j.job));
          return;
        }
        finish(folder, j, { id: j.job.id, ok: false, status: code, error: text.slice(0, 2000) });
      });
      if (rateLimited) return;
    }
  } finally {
    lock.releaseLock();
  }
}

function finish(folder, j, result) {
  folder.createFile("result_" + j.job.id + ".json", JSON.stringify(result), "application/json");
  j.file.setTrashed(true);
}

// ---------------- 補助 ----------------

function ensureTrigger() {
  const exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === "processQueue";
  });
  if (!exists) ScriptApp.newTrigger("processQueue").timeBased().everyMinutes(1).create();
}

function getFolder() {
  const it = DriveApp.getFoldersByName(FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER_NAME);
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** 最初に 1 回だけエディタから実行して、ドライブなどへのアクセスを許可するための関数 */
function setup() {
  getFolder();
  ensureTrigger();
  Logger.log("準備ができました。次に「デプロイ」→「新しいデプロイ」でウェブアプリとして公開してください。");
}
