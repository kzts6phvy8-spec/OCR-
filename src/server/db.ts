import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { OcrJob, Warlord, WarlordInput } from "../shared/types.ts";
import { config } from "./config.ts";

// 武将は (name, is_special) を一意キーとして別レコード管理する。
// 本体は JSON 列に保持し、検索・一意制約に必要な列だけを正規の列にしている。

let db: DatabaseSync;

export function openDb(file = config.dbPath): DatabaseSync {
  if (file !== ":memory:") fs.mkdirSync(config.dataDir, { recursive: true });
  db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS warlords (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      is_special INTEGER NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (name, is_special)
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

export class ConflictError extends Error {}

type Row = { id: string; data: string; created_at: string; updated_at: string };

function rowToWarlord(row: Row): Warlord {
  const data = JSON.parse(row.data) as WarlordInput;
  return {
    ...data,
    id: row.id,
    screenshot_count: data.gallery_images.length,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listWarlords(): Warlord[] {
  const rows = db.prepare("SELECT id, data, created_at, updated_at FROM warlords ORDER BY created_at DESC").all() as Row[];
  return rows.map(rowToWarlord);
}

export function getWarlord(id: string): Warlord | null {
  const row = db.prepare("SELECT id, data, created_at, updated_at FROM warlords WHERE id = ?").get(id) as Row | undefined;
  return row ? rowToWarlord(row) : null;
}

export function findWarlord(name: string, isSpecial: boolean): Warlord | null {
  const row = db
    .prepare("SELECT id, data, created_at, updated_at FROM warlords WHERE name = ? AND is_special = ?")
    .get(name, isSpecial ? 1 : 0) as Row | undefined;
  return row ? rowToWarlord(row) : null;
}

function assertUnique(input: WarlordInput, selfId: string | null) {
  const other = findWarlord(input.name, input.is_special);
  if (other && other.id !== selfId) {
    throw new ConflictError(
      `${input.is_special ? "特異" : "通常"}武将「${input.name}」は既に登録されています`,
    );
  }
}

export function insertWarlord(input: WarlordInput, opts: { id?: string; created_at?: string } = {}): Warlord {
  assertUnique(input, null);
  const now = new Date().toISOString();
  const id = opts.id ?? randomUUID();
  db.prepare(
    "INSERT INTO warlords (id, name, is_special, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, input.name, input.is_special ? 1 : 0, JSON.stringify(input), opts.created_at ?? now, now);
  return getWarlord(id)!;
}

export function updateWarlord(id: string, input: WarlordInput): Warlord {
  assertUnique(input, id);
  const now = new Date().toISOString();
  db.prepare("UPDATE warlords SET name = ?, is_special = ?, data = ?, updated_at = ? WHERE id = ?").run(
    input.name,
    input.is_special ? 1 : 0,
    JSON.stringify(input),
    now,
    id,
  );
  return getWarlord(id)!;
}

export function deleteWarlord(id: string): boolean {
  return db.prepare("DELETE FROM warlords WHERE id = ?").run(id).changes > 0;
}

export function deleteAllWarlords() {
  db.exec("DELETE FROM warlords");
}

export function transaction<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// ---- OCR ジョブ ----

export function saveJob(job: OcrJob) {
  db.prepare(
    "INSERT INTO jobs (id, status, data, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data",
  ).run(job.id, job.status, JSON.stringify(job), job.created_at);
}

export function listJobs(limit = 200): OcrJob[] {
  const rows = db.prepare("SELECT data FROM jobs ORDER BY rowid DESC LIMIT ?").all(limit) as { data: string }[];
  return rows.map((r) => JSON.parse(r.data) as OcrJob);
}

export function getJob(id: string): OcrJob | null {
  const row = db.prepare("SELECT data FROM jobs WHERE id = ?").get(id) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as OcrJob) : null;
}

export function nextQueuedJob(): OcrJob | null {
  const row = db.prepare("SELECT data FROM jobs WHERE status = 'queued' ORDER BY rowid ASC LIMIT 1").get() as
    | { data: string }
    | undefined;
  return row ? (JSON.parse(row.data) as OcrJob) : null;
}

export function deleteFinishedJobs() {
  db.exec("DELETE FROM jobs WHERE status IN ('done', 'error')");
}

/** 再起動時、処理中のまま止まったジョブをキューに戻す */
export function requeueStaleJobs() {
  for (const job of listJobs(10_000).filter((j) => j.status === "processing")) {
    saveJob({ ...job, status: "queued" });
  }
}

export function isImageReferenced(url: string): boolean {
  const row = db.prepare("SELECT 1 FROM warlords WHERE data LIKE ? LIMIT 1").get(`%${JSON.stringify(url).slice(1, -1)}%`);
  return Boolean(row);
}
