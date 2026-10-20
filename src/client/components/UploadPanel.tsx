import { useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Clock, ImagePlus, Loader2, RotateCcw, ScanLine, XCircle } from "lucide-react";
import { FACTIONS, type Faction, type OcrJob, type UploadMode, type Warlord } from "../../core/types.ts";
import { api } from "../lib/api.ts";
import { useToast } from "../lib/toast.tsx";
import { StoredImage } from "./StoredImage.tsx";

const isImage = (f: File) => f.type.startsWith("image/") || /\.(png|jpe?g|webp|heic|heif)$/i.test(f.name);

const MODES: { id: UploadMode; label: string }[] = [
  { id: "auto", label: "自動判定" },
  { id: "force_normal", label: "通常武将" },
  { id: "force_special", label: "特異武将" },
];

interface Props {
  jobs: OcrJob[];
  warlords: Warlord[];
  model?: string;
  hasApiKey: boolean;
  onOpenWarlord: (id: string) => void;
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-xl border px-3.5 py-2 text-sm font-bold transition ${
        active ? "border-shu-400 bg-shu-500/20 text-shu-300 shadow-[0_0_0_1px_rgb(224_129_42/0.4)]" : "border-ebony-600 text-washi/85 hover:border-ebony-500"
      }`}
    >
      {children}
    </button>
  );
}

export function UploadPanel({ jobs, warlords, model, hasApiKey, onOpenWarlord }: Props) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<UploadMode>("auto");
  const [faction, setFaction] = useState<Faction | "">("");
  const [targetId, setTargetId] = useState("");
  const [dragging, setDragging] = useState(false);
  const [preparing, setPreparing] = useState<number | null>(null);

  /** 写真を選んだらすぐ解析を始める (枚数無制限。20 枚ずつ保存して順次キューへ) */
  const start = async (list: FileList | File[]) => {
    const all = Array.from(list);
    const files = all.filter(isImage);
    if (files.length < all.length) toast("warning", "画像以外のファイルを除外しました");
    if (files.length === 0) return;
    setPreparing(0);
    try {
      const CHUNK = 20;
      let count = 0;
      for (let i = 0; i < files.length; i += CHUNK) {
        const chunk = files.slice(i, i + CHUNK);
        const jobs = await api.upload(chunk, { mode, targetId: targetId || null, faction }, (r) =>
          setPreparing((i + r * chunk.length) / files.length),
        );
        count += jobs.length;
      }
      toast("info", `${count} 枚の解析を開始しました`, "終わるまでアプリを開いたままにしてください");
    } catch (e) {
      toast("error", "画像の読み込みに失敗しました", (e as Error).message);
    } finally {
      setPreparing(null);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void start(e.dataTransfer.files);
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
    } catch (e) {
      toast("error", "再試行できませんでした", (e as Error).message);
    }
  };

  const sortedWarlords = useMemo(() => [...warlords].sort((a, b) => a.name.localeCompare(b.name, "ja")), [warlords]);

  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <section
        className={`panel border-shu-700/50 p-5 sm:p-7 ${dragging ? "ring-2 ring-shu-400" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <h2 className="gold-text text-center font-serif text-2xl leading-snug font-extrabold sm:text-3xl">
          スクショを複数まとめて
          <br className="sm:hidden" />
          アップロード & 自動OCR保存
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-center text-sm leading-relaxed text-ash">
          武将詳細画面のスクリーンショットを何枚でもまとめて選べます。同じ武将の写真・情報は 1 人に自動統合されます。通常武将と特異武将
          (同名) は別武将として保存されます。
        </p>

        <button
          onClick={() => inputRef.current?.click()}
          disabled={preparing !== null}
          className="mx-auto mt-6 flex w-full max-w-md items-center justify-center gap-2 rounded-2xl bg-gradient-to-b from-shu-400 to-shu-600 px-5 py-4 text-base font-extrabold text-white shadow-[0_10px_30px_-10px_rgb(224_129_42/0.7)] transition active:scale-[0.98] disabled:opacity-60"
        >
          {preparing !== null ? (
            <>
              <Loader2 className="size-5 animate-spin" /> 画像を準備中… {Math.round(preparing * 100)}%
            </>
          ) : (
            <>
              <ImagePlus className="size-5" /> 画像ファイルを選択 (複数選択可)
            </>
          )}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void start(e.target.files);
            e.target.value = "";
          }}
        />
        {!hasApiKey && <p className="mt-3 text-center text-xs text-hi-400">※ 先に「設定」で API キーを登録してください</p>}

        <div className="mt-7 space-y-5 border-t border-ebony-700 pt-5">
          <div>
            <p className="mb-2 text-xs font-bold tracking-wider text-ash">
              勢力 <span className="font-normal text-ebony-500">(選ぶと、この後アップロードする武将に設定されます)</span>
            </p>
            <div className="flex flex-wrap gap-2">
              <Chip active={faction === ""} onClick={() => setFaction("")}>
                AI に任せる
              </Chip>
              {FACTIONS.map((f) => (
                <Chip key={f} active={faction === f} onClick={() => setFaction(f)}>
                  {f}
                </Chip>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-bold tracking-wider text-ash">
              通常 / 特異 <span className="font-normal text-ebony-500">(自動判定は画面の【特】表記で判定)</span>
            </p>
            <div className="flex flex-wrap gap-2">
              {MODES.map((m) => (
                <Chip key={m.id} active={mode === m.id} onClick={() => setMode(m.id)}>
                  {m.id === "auto" ? m.label : `強制: ${m.label}`}
                </Chip>
              ))}
            </div>
          </div>

          <label className="block">
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
          {model && <p className="text-[11px] text-ebony-500">AI モデル: {model}</p>}
        </div>
      </section>

      <section className="panel flex flex-col p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-serif text-lg font-bold text-gold-400">
            <ScanLine className="size-5" /> 解析キュー
          </h2>
          {jobs.some((j) => j.status === "done" || j.status === "error") && (
            <button onClick={() => void api.clearFinishedJobs()} className="text-xs text-ash hover:text-washi">
              完了済みを消去
            </button>
          )}
        </div>

        {batch.length > 0 && (
          <div className="mb-4 rounded-lg border border-ebony-700 bg-ebony-900 p-3">
            <div className="mb-1.5 flex justify-between text-xs">
              <span className="truncate text-ash">{processing ? `解析中: ${processing.file_name}` : "待機中…"}</span>
              <span className="font-bold text-shu-300">
                {batchDone} / {batch.length}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-ebony-800">
              <div
                className="h-full rounded-full bg-gradient-to-r from-hi-500 via-shu-500 to-gold-300 transition-all duration-500"
                style={{ width: `${(batchDone / batch.length) * 100}%` }}
              />
            </div>
          </div>
        )}

        {jobs.length === 0 ? (
          <div className="grid place-items-center py-10 text-sm text-ebony-500">まだ解析履歴はありません</div>
        ) : (
          <ul className="scroll-thin -mr-2 space-y-2 overflow-y-auto pr-2" style={{ maxHeight: "36rem" }}>
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
        <StoredImage id={job.image_id} alt="" className="size-full object-cover" />
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
          {job.faction && <span className="ml-2 rounded bg-ebony-700 px-1 text-[10px]">{job.faction}</span>}
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
