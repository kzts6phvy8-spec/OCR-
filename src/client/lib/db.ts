import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { OcrJob, Warlord, WarlordInput } from "../../core/types.ts";
import type { WarlordRepo } from "../../core/ingest.ts";

// 端末内データベース (IndexedDB)。武将は (name, is_special) を一意キーとして別レコード管理する。

type StoredWarlord = Warlord & { key: string };

interface Schema extends DBSchema {
  warlords: { key: string; value: StoredWarlord; indexes: { by_key: string } };
  images: { key: string; value: { id: string; blob: Blob; created_at: string } };
  jobs: { key: string; value: OcrJob & { seq: number }; indexes: { by_seq: number } };
}

let dbPromise: Promise<IDBPDatabase<Schema>> | null = null;

function db() {
  dbPromise ??= openDB<Schema>("sengoku-fubu", 1, {
    upgrade(d) {
      d.createObjectStore("warlords", { keyPath: "id" }).createIndex("by_key", "key", { unique: true });
      d.createObjectStore("images", { keyPath: "id" });
      d.createObjectStore("jobs", { keyPath: "id" }).createIndex("by_seq", "seq");
    },
  });
  return dbPromise;
}

const uniqueKey = (name: string, isSpecial: boolean) => `${name}\u0000${isSpecial ? 1 : 0}`;

export class ConflictError extends Error {}

function strip({ key: _k, ...w }: StoredWarlord): Warlord {
  return w;
}

// ---- 武将 ----

export async function listWarlords(): Promise<Warlord[]> {
  const all = await (await db()).getAll("warlords");
  return all.map(strip).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function getWarlord(id: string): Promise<Warlord | null> {
  const w = await (await db()).get("warlords", id);
  return w ? strip(w) : null;
}

export async function findWarlord(name: string, isSpecial: boolean): Promise<Warlord | null> {
  const w = await (await db()).getFromIndex("warlords", "by_key", uniqueKey(name, isSpecial));
  return w ? strip(w) : null;
}

async function assertUnique(input: WarlordInput, selfId: string | null) {
  const other = await findWarlord(input.name, input.is_special);
  if (other && other.id !== selfId) {
    throw new ConflictError(`${input.is_special ? "特異" : "通常"}武将「${input.name}」は既に登録されています`);
  }
}

export async function insertWarlord(input: WarlordInput, opts: { id?: string; created_at?: string } = {}): Promise<Warlord> {
  await assertUnique(input, null);
  const now = new Date().toISOString();
  const row: StoredWarlord = {
    ...input,
    id: opts.id ?? crypto.randomUUID(),
    key: uniqueKey(input.name, input.is_special),
    screenshot_count: input.gallery_images.length,
    created_at: opts.created_at ?? now,
    updated_at: now,
  };
  await (await db()).add("warlords", row);
  return strip(row);
}

export async function updateWarlord(id: string, input: WarlordInput): Promise<Warlord> {
  await assertUnique(input, id);
  const current = await (await db()).get("warlords", id);
  if (!current) throw new Error("武将が見つかりません");
  const row: StoredWarlord = {
    ...input,
    id,
    key: uniqueKey(input.name, input.is_special),
    screenshot_count: input.gallery_images.length,
    created_at: current.created_at,
    updated_at: new Date().toISOString(),
  };
  await (await db()).put("warlords", row);
  return strip(row);
}

export async function deleteWarlord(id: string) {
  await (await db()).delete("warlords", id);
}

export async function deleteAllWarlords() {
  await (await db()).clear("warlords");
}

/** 武将・画像・解析履歴をすべて消す (設定と API キーは残る) */
export async function deleteEverything() {
  const d = await db();
  await d.clear("warlords");
  await d.clear("images");
  await d.clear("jobs");
}

export const repo: WarlordRepo = {
  get: getWarlord,
  find: findWarlord,
  insert: (input) => insertWarlord(input),
  update: updateWarlord,
};

// ---- 画像 ----

export async function putImage(blob: Blob, id: string = crypto.randomUUID()): Promise<string> {
  await (await db()).put("images", { id, blob, created_at: new Date().toISOString() });
  return id;
}

export async function getImage(id: string): Promise<Blob | null> {
  return (await (await db()).get("images", id))?.blob ?? null;
}

/** どの武将・未完了ジョブからも参照されていない画像を削除する */
export async function removeUnreferencedImages(ids: string[]) {
  if (ids.length === 0) return;
  const d = await db();
  const used = new Set<string>();
  for (const w of await d.getAll("warlords")) w.gallery_images.forEach((g) => used.add(g));
  for (const j of await d.getAll("jobs")) if (j.status !== "done") used.add(j.image_id);
  for (const id of ids) if (!used.has(id)) await d.delete("images", id);
}

// ---- 解析ジョブ ----

let seq = Date.now();

export async function saveJob(job: OcrJob) {
  const d = await db();
  const prev = await d.get("jobs", job.id);
  await d.put("jobs", { ...job, seq: prev?.seq ?? seq++ });
}

export async function listJobs(): Promise<OcrJob[]> {
  const rows = await (await db()).getAllFromIndex("jobs", "by_seq");
  return rows.reverse().map(({ seq: _s, ...j }) => j);
}

export async function getJob(id: string): Promise<OcrJob | null> {
  const j = await (await db()).get("jobs", id);
  if (!j) return null;
  const { seq: _s, ...rest } = j;
  return rest;
}

export async function nextQueuedJob(): Promise<OcrJob | null> {
  const rows = await (await db()).getAllFromIndex("jobs", "by_seq");
  const j = rows.find((r) => r.status === "queued");
  if (!j) return null;
  const { seq: _s, ...rest } = j;
  return rest;
}

export async function deleteJobs(ids: string[]) {
  const d = await db();
  for (const id of ids) await d.delete("jobs", id);
}

export async function deleteFinishedJobs(): Promise<string[]> {
  const d = await db();
  const failedImages: string[] = [];
  for (const j of await d.getAll("jobs")) {
    if (j.status === "done" || j.status === "error") {
      if (j.status === "error") failedImages.push(j.image_id);
      await d.delete("jobs", j.id);
    }
  }
  return failedImages;
}

/** アプリを閉じて中断されたジョブをキューに戻す */
export async function requeueStaleJobs() {
  for (const j of await listJobs()) if (j.status === "processing") await saveJob({ ...j, status: "queued" });
}
