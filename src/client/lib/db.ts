import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { OcrJob, Warlord, WarlordInput } from "../../core/types.ts";
import type { WarlordRepo } from "../../core/ingest.ts";

// 端末内データベース (IndexedDB)。
// 武将は名前が同じでも別の武将がいる (通常 / 特異 / 姫武将などの別版) ので、名前は一意にしない。
// どの武将に統合するかは、解析時に立ち絵・通常/特異・勢力で決める (core/ingest.ts)。

type StoredWarlord = Warlord & { key?: string };

interface Schema extends DBSchema {
  warlords: { key: string; value: StoredWarlord; indexes: { by_name: string } };
  images: { key: string; value: { id: string; blob: Blob; created_at: string } };
  jobs: { key: string; value: OcrJob & { seq: number }; indexes: { by_seq: number } };
  /** 画像ごとの立ち絵の「指紋」(画像を開かずに見比べるため。visual.ts) */
  signatures: { key: string; value: { id: string; sig: Float32Array } };
}

let dbPromise: Promise<IDBPDatabase<Schema>> | null = null;

function db() {
  dbPromise ??= openDB<Schema>("sengoku-fubu", 3, {
    // 別の画面 (古い版のアプリなど) が新しい版のデータベースを開こうとしたら、こちらは閉じて道を譲る
    blocking() {
      void dbPromise?.then((d) => d.close());
      dbPromise = null;
    },
    // iPhone はアプリが裏に回った時などにデータベースの接続を閉じることがある。次に使う時に開き直す
    terminated() {
      dbPromise = null;
    },
    upgrade(d, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
        d.createObjectStore("warlords", { keyPath: "id" });
        d.createObjectStore("images", { keyPath: "id" });
        d.createObjectStore("jobs", { keyPath: "id" }).createIndex("by_seq", "seq");
      }
      if (oldVersion < 2) {
        // 版 1 は (名前, 通常/特異) を一意にしていたため、同じ名前の別の武将 (姫武将など) を登録できなかった
        const store = tx.objectStore("warlords");
        if ((store.indexNames as DOMStringList).contains("by_key")) (store as unknown as IDBObjectStore).deleteIndex("by_key");
        store.createIndex("by_name", "name");
      }
      if (oldVersion < 3) d.createObjectStore("signatures", { keyPath: "id" });
    },
  });
  const p = dbPromise;
  // 開けなかった時は、次に使う時にもう一度開き直す
  p.catch(() => {
    if (dbPromise === p) dbPromise = null;
  });
  return p;
}

/** 接続が閉じられていた (「The database connection is closing」など) ことによる失敗か */
function isClosedConnection(err: unknown) {
  return (
    err instanceof DOMException &&
    (err.name === "InvalidStateError" || err.name === "UnknownError" || /closing|closed/i.test(err.message))
  );
}

/** 接続が閉じられていたら開き直して 1 回だけやり直す */
function retrying<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (!isClosedConnection(err)) throw err;
      dbPromise = null;
      return fn(...args);
    }
  };
}

function strip({ key: _k, ...w }: StoredWarlord): Warlord {
  return w;
}

// ---- 武将 ----

export const listWarlords = retrying(async function listWarlords(): Promise<Warlord[]> {
  const all = await (await db()).getAll("warlords");
  return all.map(strip).sort((a, b) => b.created_at.localeCompare(a.created_at));
});

export const getWarlord = retrying(async function getWarlord(id: string): Promise<Warlord | null> {
  const w = await (await db()).get("warlords", id);
  return w ? strip(w) : null;
});

/** 登録済みの武将名の一覧 (重複なし)。武将の中身は読まないので速い */
export const listNames = retrying(async function listNames(): Promise<string[]> {
  const names = new Set<string>();
  let cursor = await (await db()).transaction("warlords").store.index("by_name").openKeyCursor(null, "nextunique");
  while (cursor) {
    names.add(String(cursor.key));
    cursor = await cursor.continue();
  }
  return [...names];
});

/** 同じ名前の武将すべて */
export const findByName = retrying(async function findByName(name: string): Promise<Warlord[]> {
  return (await (await db()).getAllFromIndex("warlords", "by_name", name)).map(strip);
});

export const insertWarlord = retrying(async function insertWarlord(input: WarlordInput, opts: { id?: string; created_at?: string } = {}): Promise<Warlord> {
  const now = new Date().toISOString();
  const row: StoredWarlord = {
    ...input,
    id: opts.id ?? crypto.randomUUID(),
    screenshot_count: input.gallery_images.length,
    created_at: opts.created_at ?? now,
    updated_at: now,
  };
  await (await db()).add("warlords", row);
  return strip(row);
});

export const updateWarlord = retrying(async function updateWarlord(id: string, input: WarlordInput): Promise<Warlord> {
  const current = await (await db()).get("warlords", id);
  if (!current) throw new Error("武将が見つかりません");
  const row: StoredWarlord = {
    ...input,
    id,
    screenshot_count: input.gallery_images.length,
    created_at: current.created_at,
    updated_at: new Date().toISOString(),
  };
  await (await db()).put("warlords", row);
  return strip(row);
});

export const deleteWarlord = retrying(async function deleteWarlord(id: string) {
  await (await db()).delete("warlords", id);
});

export const deleteAllWarlords = retrying(async function deleteAllWarlords() {
  await (await db()).clear("warlords");
});

/** 武将・画像・解析履歴をすべて消す (設定と API キーは残る) */
export const deleteEverything = retrying(async function deleteEverything() {
  const d = await db();
  await d.clear("warlords");
  await d.clear("images");
  await d.clear("jobs");
  await d.clear("signatures");
});

export const repo: WarlordRepo = {
  get: getWarlord,
  findByName,
  insert: (input) => insertWarlord(input),
  update: updateWarlord,
};

// ---- 画像 ----

export const putImage = retrying(async function putImage(blob: Blob, id: string = crypto.randomUUID()): Promise<string> {
  await (await db()).put("images", { id, blob, created_at: new Date().toISOString() });
  return id;
});

export const getImage = retrying(async function getImage(id: string): Promise<Blob | null> {
  return (await (await db()).get("images", id))?.blob ?? null;
});

/** どの武将・未完了ジョブからも参照されていない画像を削除する */
export const removeUnreferencedImages = retrying(async function removeUnreferencedImages(ids: string[]) {
  if (ids.length === 0) return;
  const d = await db();
  const used = new Set<string>();
  for (const w of await d.getAll("warlords")) w.gallery_images.forEach((g) => used.add(g));
  for (const j of await d.getAll("jobs")) if (j.status !== "done") used.add(j.image_id);
  for (const id of ids) {
    if (used.has(id)) continue;
    await d.delete("images", id);
    await d.delete("signatures", id);
  }
});

// ---- 解析ジョブ ----

let seq = Date.now();

export const saveJob = retrying(async function saveJob(job: OcrJob) {
  const d = await db();
  const prev = await d.get("jobs", job.id);
  await d.put("jobs", { ...job, seq: prev?.seq ?? seq++ });
});

export const listJobs = retrying(async function listJobs(): Promise<OcrJob[]> {
  const rows = await (await db()).getAllFromIndex("jobs", "by_seq");
  return rows.reverse().map(({ seq: _s, ...j }) => j);
});

export const getJob = retrying(async function getJob(id: string): Promise<OcrJob | null> {
  const j = await (await db()).get("jobs", id);
  if (!j) return null;
  const { seq: _s, ...rest } = j;
  return rest;
});

export const nextQueuedJob = retrying(async function nextQueuedJob(): Promise<OcrJob | null> {
  const rows = await (await db()).getAllFromIndex("jobs", "by_seq");
  const j = rows.find((r) => r.status === "queued");
  if (!j) return null;
  const { seq: _s, ...rest } = j;
  return rest;
});

export const deleteJobs = retrying(async function deleteJobs(ids: string[]) {
  const d = await db();
  for (const id of ids) await d.delete("jobs", id);
});

export const deleteFinishedJobs = retrying(async function deleteFinishedJobs(): Promise<string[]> {
  const d = await db();
  const failedImages: string[] = [];
  for (const j of await d.getAll("jobs")) {
    if (j.status === "done" || j.status === "error") {
      if (j.status === "error" && !j.keep_image) failedImages.push(j.image_id);
      await d.delete("jobs", j.id);
    }
  }
  return failedImages;
});

/** アプリを閉じて中断されたジョブをキューに戻す */
export const requeueStaleJobs = retrying(async function requeueStaleJobs() {
  for (const j of await listJobs()) if (j.status === "processing") await saveJob({ ...j, status: "queued" });
});

// ---- 立ち絵の指紋 ----

export const getSignature = retrying(async function getSignature(id: string): Promise<Float32Array | null> {
  return (await (await db()).get("signatures", id))?.sig ?? null;
});

export const putSignature = retrying(async function putSignature(id: string, sig: Float32Array) {
  await (await db()).put("signatures", { id, sig });
});

/** 保存済みの指紋をすべて (画像 ID → 指紋) */
export const listSignatures = retrying(async function listSignatures(): Promise<Map<string, Float32Array>> {
  const rows = await (await db()).getAll("signatures");
  return new Map(rows.map((r) => [r.id, r.sig]));
});

/** 画像 ID の一覧 (中身は読まない) */
export const listImageIds = retrying(async function listImageIds(): Promise<string[]> {
  return (await (await db()).getAllKeys("images")) as string[];
});
