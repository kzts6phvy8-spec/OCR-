import { useMemo, useRef, useState, type DragEvent } from "react";
import {
  CheckCircle2,
  Clock,
  ImagePlus,
  Loader2,
  RotateCcw,
  ScanLine,
  Trash2,
  UploadCloud,
  XCircle,
  AlertTriangle,
} from "lucide-react";
import type { OcrJob, UploadMode, Warlord } from "../../shared/types.ts";
import { api } from "../lib/api.ts";
import { useToast } from "../lib/toast.tsx";

const ACCEPT = ["image/png", "image/jpeg", "image/webp"];

const MODES: { id: UploadMode; label: string; desc: string }[] = [
  { id: "auto", label: "自動判定", desc: "画面の【特】表記から判定" },
  { id: "force_normal", label: "強制: 通常武将", desc: "すべて通常武将として登録" },
  { id: "force_special", label: "強制: 特異武将", desc: "すべて特異武将として登録" },
];

interface Props {
  jobs: OcrJob[];
  warlords: Warlord[];
  model?: string;
  onUploaded: (jobs: OcrJob[]) => void;
  onOpenWarlord: (id: string) => void;
}

export function UploadPanel({ jobs, warlords, model, onUploaded, onOpenWarlord }: Props) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [mode, setMode] = useState<UploadMode>("auto");
  const [targetId, setTargetId] = useState("");
  const [dragging, setDragging] = useState(false);
  const [uploadRatio, setUploadRatio] = useState<number | null>(null);

  const previews = useMemo(() => files.map((f) => ({ file: f, url: URL.createObjectURL(f) })), [files]);

  const addFiles = (list: FileList | File[]) => {
    const arr = Array.from(list);
    const ok = arr.filter((f) => ACCEPT.includes(f.type));
    if (ok.length < arr.length) toast("warning", "PNG / JPEG / WebP 以外のファイルを除外しました");
    setFiles((cur) => [...cur, ...ok]);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  };

  const start = async () => {
    if (files.length === 0) return;
    setUploadRatio(0);
    try {
      // 枚数の上限は無し。1 回の通信が大きくなりすぎないよう、20 枚ずつに分けて送る
      const CHUNK = 20;
      const totalBytes = files.reduce((n, f) => n + f.size, 0) || 1;
      let sentBytes = 0;
      const created = [];
      for (let i = 0; i < files.length; i += CHUNK) {
        const chunk = files.slice(i, i + CHUNK);
        const chunkBytes = chunk.reduce((n, f) => n + f.size, 0);
        const jobs = await api.upload(chunk, mode, targetId || null, (r) => setUploadRatio((sentBytes + r * chunkBytes) / totalBytes));
        sentBytes += chunkBytes;
        created.push(...jobs);
        onUploaded(jobs);
        setFiles((cur) => cur.filter((f) => !chunk.includes(f)));
      }
      toast("info", `${created.length} 枚を解析キューに追加しました`, "バックグラウンドで順番に解析します");
    } catch (e) {
      toast("error", "アップロードに失敗しました", (e as Error).message);
    } finally {
      setUploadRatio(null);
    }
  };

  // 進捗バー: 最も古い未完了ジョブ以降に追加されたジョブを「現在のバッチ」とする
  const pending = jobs.filter((j) => j.status === "queued" || j.status === "processing");
  const batch = useMemo(() => {
    if (pending.length === 0) return [];
    const since = Math.min(...pending.map((j) => Date.parse(j.created_at)));
    return jobs.filter((j) => Date.parse(j.created_at) >= since);
  }, [jobs, pending]);
  const batchDone = batch.filter((j) => j.status === "done" || j.status === "error").length;
  const processing = jobs.find((j) => j.status === "processing");

  const retry = async (id: string) => {
    try {
      await api.retryJob(id);
      onUploaded([]);
    } catch (e) {
      toast("error", "再試行できませんでした", (e as Error).message);
    }
  };

  const clearFinished = async () => {
    await api.clearFinishedJobs();
    onUploaded([]);
  };

  const sortedWarlords = useMemo(() => [...warlords].sort((a, b) => a.name.localeCompare(b.name, "ja")), [warlords]);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <section className="panel p-5">
        <h2 className="mb-1 flex items-center gap-2 font-serif text-lg font-bold text-gold-400">
          <ScanLine className="size-5" /> スクリーンショット一括解析
        </h2>
        <p className="mb-4 text-xs text-ash">
          1 人の武将につき 2〜4 枚 (基本情報・スキル・覚醒・天賦・連携) をまとめてアップロードすると、同じ武将に自動で統合されます。
          {model && <span className="ml-1 text-ebony-500">モデル: {model}</span>}
        </p>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-10 text-center transition ${
            dragging ? "border-gold-400 bg-gold-500/10" : "border-ebony-600 hover:border-gold-600 hover:bg-ebony-800/50"
          }`}
        >
          <UploadCloud className={`size-10 ${dragging ? "text-gold-400" : "text-ebony-500"}`} />
          <p className="text-sm font-medium">ここに画像をドラッグ＆ドロップ</p>
          <p className="text-xs text-ash">またはクリックして選択 (PNG / JPEG / WebP・枚数制限なし)</p>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={ACCEPT.join(",")}
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>

        {previews.length > 0 && (
          <div className="mt-4 grid grid-cols-4 gap-2 sm:grid-cols-6">
            {previews.map(({ file, url }, i) => (
              <div key={url} className="group relative aspect-[9/16] overflow-hidden rounded-md border border-ebony-700">
                <img src={url} alt={file.name} className="size-full object-cover" />
                <button
                  onClick={() => setFiles((cur) => cur.filter((_, idx) => idx !== i))}
                  className="absolute top-1 right-1 rounded bg-ebony-950/80 p-1 text-ash opacity-0 transition group-hover:opacity-100 hover:text-hi-400"
                  aria-label="除外"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        <fieldset className="mt-5">
          <legend className="mb-2 text-xs font-bold tracking-wider text-ash">通常 / 特異 の判定</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {MODES.map((m) => (
              <label
                key={m.id}
                className={`cursor-pointer rounded-lg border px-3 py-2 transition ${
                  mode === m.id ? "border-gold-500 bg-gold-500/10" : "border-ebony-700 hover:border-ebony-500"
                }`}
              >
                <input type="radio" name="mode" className="sr-only" checked={mode === m.id} onChange={() => setMode(m.id)} />
                <span className={`block text-sm font-bold ${mode === m.id ? "text-gold-300" : ""}`}>{m.label}</span>
                <span className="block text-[11px] text-ash">{m.desc}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="mt-4 block">
          <span className="mb-1 block text-xs font-bold tracking-wider text-ash">統合先の武将 (任意)</span>
          <select className="field" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            <option value="">自動 (読み取った武将名で統合)</option>
            {sortedWarlords.map((w) => (
              <option key={w.id} value={w.id}>
                {w.is_special ? "【特】" : ""}
                {w.name}
                {w.title_alias ? ` (${w.title_alias})` : ""}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-[11px] text-ebony-500">武将名が写っていない画面 (天賦だけ等) を追加する時に指定します</span>
        </label>

        <button
          onClick={start}
          disabled={files.length === 0 || uploadRatio !== null}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-b from-hi-500 to-hi-600 py-2.5 font-bold text-white shadow-lg transition hover:from-hi-400 hover:to-hi-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {uploadRatio !== null ? (
            <>
              <Loader2 className="size-4 animate-spin" /> アップロード中… {Math.round(uploadRatio * 100)}%
            </>
          ) : (
            <>
              <ImagePlus className="size-4" /> {files.length > 0 ? `${files.length} 枚を解析開始` : "画像を選択してください"}
            </>
          )}
        </button>
      </section>

      <section className="panel flex min-h-[24rem] flex-col p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-serif text-lg font-bold text-gold-400">解析キュー</h2>
          {jobs.some((j) => j.status === "done" || j.status === "error") && (
            <button onClick={clearFinished} className="text-xs text-ash hover:text-washi">
              完了済みを消去
            </button>
          )}
        </div>

        {batch.length > 0 && (
          <div className="mb-4 rounded-lg border border-ebony-700 bg-ebony-900 p-3">
            <div className="mb-1.5 flex justify-between text-xs">
              <span className="text-ash">
                {processing ? `解析中: ${processing.file_name}` : "待機中…"}
              </span>
              <span className="font-bold text-gold-400">
                {batchDone} / {batch.length}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-ebony-800">
              <div
                className="h-full rounded-full bg-gradient-to-r from-hi-500 via-gold-500 to-gold-300 transition-all duration-500"
                style={{ width: `${(batchDone / batch.length) * 100}%` }}
              />
            </div>
          </div>
        )}

        {jobs.length === 0 ? (
          <div className="grid flex-1 place-items-center text-sm text-ebony-500">まだ解析履歴はありません</div>
        ) : (
          <ul className="scroll-thin -mr-2 flex-1 space-y-2 overflow-y-auto pr-2" style={{ maxHeight: "36rem" }}>
            {jobs.map((job) => (
              <JobRow key={job.id} job={job} onRetry={retry} onOpen={onOpenWarlord} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function JobRow({ job, onRetry, onOpen }: { job: OcrJob; onRetry: (id: string) => void; onOpen: (id: string) => void }) {
  return (
    <li className="flex gap-3 rounded-lg border border-ebony-700 bg-ebony-900/70 p-2">
      <div className="relative h-16 w-10 shrink-0 overflow-hidden rounded border border-ebony-700 bg-ebony-800">
        <img src={job.image_url} alt="" className="size-full object-cover" loading="lazy" />
        {job.status === "processing" && (
          <div className="absolute inset-0 overflow-hidden bg-gold-500/10">
            <div className="scan-line h-full w-full bg-gradient-to-b from-transparent via-gold-400/70 to-transparent" />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <StatusIcon status={job.status} />
          <p className="truncate text-sm font-medium">{job.file_name}</p>
        </div>
        <p className="mt-0.5 text-xs text-ash">
          {job.status === "queued" && "待機中"}
          {job.status === "processing" && <span className="text-gold-400">AI が画像を解析しています…</span>}
          {job.status === "done" && (
            <button onClick={() => job.warlord_id && onOpen(job.warlord_id)} className="text-gold-300 underline-offset-2 hover:underline">
              {job.warlord_label} を{job.merged ? "統合更新" : "新規登録"}
            </button>
          )}
          {job.status === "error" && <span className="text-hi-400">{job.error}</span>}
          {job.mode !== "auto" && (
            <span className="ml-2 rounded bg-ebony-700 px-1 text-[10px]">{job.mode === "force_special" ? "強制: 特異" : "強制: 通常"}</span>
          )}
        </p>
        {job.warnings.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {job.warnings.map((w, i) => (
              <li key={i} className="flex gap-1 text-[11px] text-amber-300/90">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                {w}
              </li>
            ))}
          </ul>
        )}
      </div>
      {job.status === "error" && (
        <button onClick={() => onRetry(job.id)} className="self-center rounded p-1.5 text-ash hover:bg-ebony-700 hover:text-washi" title="再試行">
          <RotateCcw className="size-4" />
        </button>
      )}
    </li>
  );
}

function StatusIcon({ status }: { status: OcrJob["status"] }) {
  if (status === "queued") return <Clock className="size-4 shrink-0 text-ash" />;
  if (status === "processing") return <Loader2 className="size-4 shrink-0 animate-spin text-gold-400" />;
  if (status === "done") return <CheckCircle2 className="size-4 shrink-0 text-gold-400" />;
  return <XCircle className="size-4 shrink-0 text-hi-400" />;
}
