import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import type { ExportPayload, HealthInfo, UploadMode, Warlord, WarlordInput } from "../shared/types.ts";
import { config, hasApiKey } from "./config.ts";
import * as db from "./db.ts";
import { normalizeInput } from "./domain.ts";
import { toInput } from "./ingest.ts";
import * as jobs from "./jobs.ts";

db.openDb();
fs.mkdirSync(config.uploadDir, { recursive: true });
db.requeueStaleJobs();

const app = express();
app.use(express.json({ limit: "50mb" }));

const EXT_BY_MIME: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };

const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadDir,
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${EXT_BY_MIME[file.mimetype] ?? ""}`),
  }),
  limits: { fileSize: config.maxUploadBytes, files: 50 },
  fileFilter: (_req, file, cb) => {
    if (EXT_BY_MIME[file.mimetype]) cb(null, true);
    else cb(new HttpError(400, `対応していない形式です: ${file.originalname} (PNG / JPEG / WebP のみ)`));
  },
});

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function removeUnreferencedImages(urls: string[]) {
  for (const url of urls) {
    if (!url.startsWith("/uploads/") || db.isImageReferenced(url)) continue;
    if (db.listJobs(10_000).some((j) => j.image_url === url && (j.status === "queued" || j.status === "processing"))) continue;
    fs.rm(path.join(config.uploadDir, path.basename(url)), { force: true }, () => {});
  }
}

const router = express.Router();

router.get("/health", (_req, res) => {
  const info: HealthInfo = { ok: true, api_key_configured: hasApiKey(), model: config.model };
  res.json(info);
});

// ---- 武将 ----

router.get("/warlords", (_req, res) => {
  res.json(db.listWarlords());
});

router.get("/warlords/:id", (req, res) => {
  const w = db.getWarlord(req.params.id);
  if (!w) throw new HttpError(404, "武将が見つかりません");
  res.json(w);
});

router.post("/warlords", (req, res) => {
  const input = normalizeInput(req.body as Partial<WarlordInput>);
  if (!input.name) throw new HttpError(400, "武将名は必須です");
  res.status(201).json(db.insertWarlord(input));
});

router.put("/warlords/:id", (req, res) => {
  const current = db.getWarlord(req.params.id);
  if (!current) throw new HttpError(404, "武将が見つかりません");
  const input = normalizeInput({ ...toInput(current), ...(req.body as Partial<WarlordInput>) });
  if (!input.name) throw new HttpError(400, "武将名は必須です");
  const updated = db.updateWarlord(current.id, input);
  removeUnreferencedImages(current.gallery_images.filter((u) => !updated.gallery_images.includes(u)));
  res.json(updated);
});

router.delete("/warlords/:id", (req, res) => {
  const current = db.getWarlord(req.params.id);
  if (!current) throw new HttpError(404, "武将が見つかりません");
  db.deleteWarlord(current.id);
  removeUnreferencedImages(current.gallery_images);
  res.status(204).end();
});

// ---- アップロード & OCR ジョブ ----

router.post("/uploads", upload.array("files", 50), (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) throw new HttpError(400, "画像が選択されていません");
  const mode = (["auto", "force_normal", "force_special"].includes(req.body.mode) ? req.body.mode : "auto") as UploadMode;
  const targetId = typeof req.body.target_id === "string" && req.body.target_id ? req.body.target_id : null;
  if (targetId && !db.getWarlord(targetId)) throw new HttpError(400, "統合先の武将が見つかりません");
  const created = jobs.enqueue(
    files.map((f) => ({ fileName: Buffer.from(f.originalname, "latin1").toString("utf8"), storedName: f.filename })),
    mode,
    targetId,
  );
  res.status(202).json(created);
});

router.get("/jobs", (_req, res) => {
  res.json(db.listJobs());
});

router.post("/jobs/:id/retry", (req, res) => {
  const job = jobs.retryJob(req.params.id);
  if (!job) throw new HttpError(404, "再試行できるジョブがありません");
  res.json(job);
});

router.delete("/jobs/finished", (_req, res) => {
  const failedImages = db.listJobs(10_000).filter((j) => j.status === "error").map((j) => j.image_url);
  db.deleteFinishedJobs();
  removeUnreferencedImages(failedImages);
  res.status(204).end();
});

// ---- エクスポート / インポート ----

router.get("/export", (_req, res) => {
  const payload: ExportPayload = {
    app: "sengoku-fubu-warlord-db",
    version: 1,
    exported_at: new Date().toISOString(),
    warlords: db.listWarlords(),
  };
  const stamp = payload.exported_at.slice(0, 10);
  res.setHeader("Content-Disposition", `attachment; filename="warlords-${stamp}.json"`);
  res.json(payload);
});

router.post("/import", (req, res) => {
  const body = req.body as Partial<ExportPayload> | Warlord[];
  const list = Array.isArray(body) ? body : body?.warlords;
  if (!Array.isArray(list)) throw new HttpError(400, "JSON の形式が正しくありません (warlords 配列が必要です)");
  const replace = req.query.mode === "replace";

  const summary = db.transaction(() => {
    if (replace) db.deleteAllWarlords();
    let created = 0;
    let updated = 0;
    const errors: string[] = [];
    list.forEach((raw, i) => {
      const input = normalizeInput(raw ?? {});
      if (!input.name) {
        errors.push(`${i + 1} 件目: 武将名がありません`);
        return;
      }
      const existing = db.findWarlord(input.name, input.is_special);
      if (existing) {
        db.updateWarlord(existing.id, input);
        updated++;
      } else {
        const id = typeof raw?.id === "string" && !db.getWarlord(raw.id) ? raw.id : undefined;
        db.insertWarlord(input, { id, created_at: typeof raw?.created_at === "string" ? raw.created_at : undefined });
        created++;
      }
    });
    return { created, updated, errors };
  });
  res.json(summary);
});

app.use("/api", router);
app.use("/uploads", express.static(config.uploadDir, { maxAge: "7d", immutable: true }));

if (config.isProduction) {
  const clientDir = path.resolve("dist/client");
  app.use(express.static(clientDir));
  app.get(/^\/(?!api|uploads).*/, (_req, res) => res.sendFile(path.join(clientDir, "index.html")));
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message });
  if (err instanceof db.ConflictError) return void res.status(409).json({ error: err.message });
  if (err instanceof multer.MulterError) {
    const msg = err.code === "LIMIT_FILE_SIZE" ? "画像サイズが大きすぎます (最大 15MB)" : err.message;
    return void res.status(400).json({ error: msg });
  }
  console.error(err);
  res.status(500).json({ error: "サーバーエラーが発生しました" });
});

app.listen(config.port, () => {
  console.log(`戦国布武 武将図鑑 API: http://localhost:${config.port}`);
  if (!hasApiKey()) console.warn("⚠ ANTHROPIC_API_KEY が未設定です。OCR 解析は失敗します (.env を作成してください)");
  void jobs.runWorker();
});
