import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { AlertTriangle, BookOpen, CheckCircle2, Clock, Cloud, ImagePlus, Loader2, RefreshCw, RotateCcw, ScanLine, Send, X, XCircle } from "lucide-react";
import { FACTIONS, isPending, type Faction, type OcrJob, type UploadMode, type Warlord } from "../../core/types.ts";
import { api } from "../lib/api.ts";
import { CONCURRENCY, UPLOAD_CONCURRENCY, getQueueState, pollServer, resumeNow, type QueueState } from "../lib/queue.ts";
import { bgActive, loadSettings } from "../lib/settings.ts";
import { useToast } from "../lib/toast.tsx";
import { StoredImage } from "./StoredImage.tsx";

function formatDuration(ms: number) {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "1 分以内";
  if (min < 60) return `${min} 分`;
  return `${Math.floor(min / 60)} 時間 ${min % 60} 分`;
}

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
      if (bgActive(loadSettings())) toast("info", `${count} 枚をサーバーへ送信しています`, "「送信完了」と出るまでアプリを開いたままにしてください");
      else toast("info", `${count} 枚の解析を開始しました`, "終わるまでアプリを開いたままにしてください");
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
  const pending = jobs.filter((j) => isPending(j.status));
  const batch = useMemo(() => {
    if (pending.length === 0) return [];
    const since = Math.min(...pending.map((j) => Date.parse(j.created_at)));
    return jobs.filter((j) => Date.parse(j.created_at) >= since);
  }, [jobs, pending]);
  const batchDone = batch.filter((j) => j.status === "done" || j.status === "error").length;
  const processing = jobs.filter((j) => j.status === "processing");
  const failedCount = jobs.filter((j) => j.status === "error").length;
  const [showFailedOnly, setShowFailedOnly] = useState(false);
  const shownJobs = (showFailedOnly ? jobs.filter((j) => j.status === "error") : jobs).slice(0, 100);

  // 利用上限による一時停止の残り時間 (1 秒ごとに表示を更新)
  const [, setTick] = useState(0);
  const qs = getQueueState();
  useEffect(() => {
    if (!qs.pausedUntil) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [qs.pausedUntil]);

  // 残り時間の目安: 直近に終わったジョブの所要時間の平均から計算
  const eta = useMemo(() => {
    const recent = jobs
      .filter((j) => j.status === "done" && j.started_at)
      .slice(0, 20)
      .map((j) => Date.parse(j.updated_at) - Date.parse(j.started_at!))
      .filter((ms) => ms > 0);
    if (recent.length === 0 || pending.length === 0 || bgActive(loadSettings())) return null;
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    return (pending.length * avg) / CONCURRENCY;
  }, [jobs, pending.length]);

  const remove = async (ids: string[]) => {
    const n = await api.removeJobs(ids);
    if (n > 1) toast("success", `${n} 枚をキューから取り除きました`);
  };
  const waitingIds = jobs.filter((j) => j.status === "queued" || j.status === "remote").map((j) => j.id);
  const bg = bgActive(loadSettings());
  const remoteCount = jobs.filter((j) => j.status === "remote").length;

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
      {bg && (preparing !== null || batch.length > 0) && <BgStages batch={batch} preparing={preparing} qs={qs} />}
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
          <span className="mb-1 block text-xs text-shu-300">大量にある場合は 100〜200 枚ずつに分けると、途中で止まっても扱いやすくなります</span>
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

        {qs.pausedUntil && (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-500/50 bg-amber-900/20 p-3 text-xs text-amber-200">
            <Clock className="size-4 shrink-0" />
            <span className="flex-1">
              {qs.pauseReason}。{Math.ceil((qs.pausedUntil - Date.now()) / 1000)} 秒後に自動で再開します
              <span className="block text-[11px] text-amber-200/70">1 日の上限に達した場合は、翌日まで待つと再開できます (アプリは開いたままに)</span>
            </span>
            <button onClick={resumeNow} className="shrink-0 rounded-md border border-amber-400/60 px-2 py-1 font-bold">
              今すぐ再開
            </button>
          </div>
        )}

        {!bg && batch.length > 0 && (
          <div className="mb-4 rounded-lg border border-ebony-700 bg-ebony-900 p-3">
            <div className="mb-1.5 flex justify-between gap-2 text-xs">
              <span className="truncate text-ash">
                {processing.length ? `解析中: ${processing.map((j) => j.file_name).join("、")}` : "待機中…"}
              </span>
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
            <p className="mt-1.5 text-[11px] text-ebony-500">
              残り {pending.length} 枚{eta ? ` / 目安 約${formatDuration(eta)}` : ""}・解析中はアプリを開いたままにしてください
            </p>
          </div>
        )}

        {bg && (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-sky-700/60 bg-sky-950/30 p-3 text-xs text-sky-200">
            <Cloud className="size-4 shrink-0" />
            <span className="flex-1">
              バックグラウンド解析: オン{remoteCount > 0 && ` ・ サーバーで解析待ち ${remoteCount} 枚`}
              {qs.server && ` (サーバー: 未解析 ${qs.server.pending} / 受け取り待ち ${qs.server.ready})`}
              <span className="block text-[11px] text-sky-200/70">送信が終われば、アプリを閉じても Google のサーバーで解析が進みます。開くと結果を受け取ります</span>
              {qs.serverError && <span className="block text-hi-400">{qs.serverError}</span>}
            </span>
            <button onClick={() => void pollServer()} className="shrink-0 rounded-md border border-sky-600/60 p-1.5" aria-label="結果を確認" title="結果を確認">
              <RefreshCw className="size-4" />
            </button>
          </div>
        )}

        {waitingIds.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-ash">待機中 {waitingIds.length} 枚</span>
            <button
              onClick={() => {
                if (confirm(`まだ解析していない ${waitingIds.length} 枚をキューから取り除きますか？`)) void remove(waitingIds);
              }}
              className="flex items-center gap-1 rounded-md border border-ebony-600 px-2 py-1 text-washi"
            >
              <X className="size-3.5" /> 待機中をすべて取り消す
            </button>
          </div>
        )}

        {failedCount > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-hi-400">失敗 {failedCount} 枚</span>
            <button
              onClick={async () => toast("info", `${await api.retryAllFailed()} 枚を再解析します`)}
              className="flex items-center gap-1 rounded-md border border-ebony-600 px-2 py-1 text-washi"
            >
              <RotateCcw className="size-3.5" /> 失敗をすべて再試行
            </button>
            <label className="ml-auto flex items-center gap-1 text-ash">
              <input type="checkbox" checked={showFailedOnly} onChange={(e) => setShowFailedOnly(e.target.checked)} className="accent-hi-500" />
              失敗だけ表示
            </label>
          </div>
        )}

        {jobs.length === 0 ? (
          <div className="grid place-items-center py-10 text-sm text-ebony-500">まだ解析履歴はありません</div>
        ) : (
          <ul className="scroll-thin -mr-2 space-y-2 overflow-y-auto pr-2" style={{ maxHeight: "36rem" }}>
            {shownJobs.map((job) => (
              <JobRow key={job.id} job={job} onRetry={retry} onOpen={onOpenWarlord} onRemove={(id) => void remove([id])} />
            ))}
            {jobs.length > shownJobs.length && !showFailedOnly && (
              <li className="py-2 text-center text-[11px] text-ebony-500">ほか {jobs.length - shownJobs.length} 件 (新しい 100 件を表示中)</li>
            )}
          </ul>
        )}
      </section>
    </div>
  );
}

function JobRow({
  job,
  onRetry,
  onOpen,
  onRemove,
}: {
  job: OcrJob;
  onRetry: (id: string) => void;
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
}) {
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
          {job.status === "remote" && <span className="text-sky-300">サーバーで解析待ち (アプリを閉じても進みます)</span>}
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
      <div className="flex shrink-0 flex-col justify-center gap-1">
        {job.status === "error" && (
          <button onClick={() => onRetry(job.id)} className="rounded p-1.5 text-ash hover:bg-ebony-700 hover:text-washi" title="再試行" aria-label="再試行">
            <RotateCcw className="size-4" />
          </button>
        )}
        {(job.status === "queued" || job.status === "remote" || job.status === "error") && (
          <button onClick={() => onRemove(job.id)} className="rounded p-1.5 text-ash hover:bg-ebony-700 hover:text-hi-400" title="キューから取り除く" aria-label="キューから取り除く">
            <X className="size-4" />
          </button>
        )}
      </div>
    </li>
  );
}

function StatusIcon({ status }: { status: OcrJob["status"] }) {
  if (status === "queued") return <Clock className="size-4 shrink-0 text-ash" />;
  if (status === "remote") return <Cloud className="size-4 shrink-0 text-sky-300" />;
  if (status === "processing") return <Loader2 className="size-4 shrink-0 animate-spin text-gold-400" />;
  if (status === "done") return <CheckCircle2 className="size-4 shrink-0 text-gold-400" />;
  return <XCircle className="size-4 shrink-0 text-hi-400" />;
}

/** バックグラウンド解析の進み具合を 4 段階で表示する (どこまで終われば閉じてよいかを分かりやすく) */
function BgStages({ batch, preparing, qs }: { batch: OcrJob[]; preparing: number | null; qs: QueueState }) {
  const total = batch.length;
  const toSend = batch.filter((j) => j.status === "queued" || j.status === "processing").length;
  const atServer = batch.filter((j) => j.status === "remote").length;
  const finished = batch.filter((j) => j.status === "done" || j.status === "error").length;
  const failed = batch.filter((j) => j.status === "error").length;
  const sent = total - toSend;

  // 送信の残り時間の目安: 送信済みのジョブの送信にかかった時間の平均から
  const sendEta = useMemo(() => {
    const times = batch
      .filter((j) => j.status === "remote" && j.started_at)
      .slice(0, 20)
      .map((j) => Date.parse(j.updated_at) - Date.parse(j.started_at!))
      .filter((ms) => ms > 0);
    if (!times.length || !toSend) return null;
    return ((times.reduce((a, b) => a + b, 0) / times.length) * toSend) / UPLOAD_CONCURRENCY;
  }, [batch, toSend]);

  const sending = preparing !== null || toSend > 0;
  const stage = preparing !== null ? 1 : toSend > 0 ? 2 : atServer > 0 ? 3 : 4;

  const steps = [
    { n: 1, icon: ImagePlus, label: "写真を取り込む", detail: preparing !== null ? `${Math.round(preparing * 100)}%` : "完了", ratio: preparing ?? 1 },
    { n: 2, icon: Send, label: "サーバーへ送信", detail: `${sent} / ${total}`, ratio: total ? sent / total : 0 },
    {
      n: 3,
      icon: Cloud,
      label: "サーバーで解析",
      detail: `残り ${atServer} 枚`,
      ratio: total ? (finished + Math.min(atServer, qs.server?.ready ?? 0)) / total : 0,
    },
    { n: 4, icon: BookOpen, label: "図鑑に反映", detail: `${finished} / ${total}${failed ? ` (失敗 ${failed})` : ""}`, ratio: total ? finished / total : 0 },
  ];

  return (
    <section className={`panel p-4 ${sending ? "border-shu-600/60" : stage === 3 ? "border-emerald-600/60" : "border-ebony-700"}`}>
      {sending ? (
        <div className="mb-4 flex items-start gap-3 rounded-xl bg-shu-500/15 p-3">
          <Loader2 className="mt-0.5 size-6 shrink-0 animate-spin text-shu-300" />
          <div>
            <p className="font-bold text-shu-300">
              {preparing !== null ? "写真を取り込んでいます…" : `サーバーへ送信中… 残り ${toSend} 枚${sendEta ? ` (約${formatDuration(sendEta)})` : ""}`}
            </p>
            <p className="mt-0.5 text-xs text-washi/80">送信が終わるまで、アプリを開いたままにしてください。終わるとここに「送信完了」と出ます。</p>
          </div>
        </div>
      ) : stage === 3 ? (
        <div className="mb-4 flex items-start gap-3 rounded-xl bg-emerald-500/15 p-3">
          <CheckCircle2 className="mt-0.5 size-6 shrink-0 text-emerald-300" />
          <div>
            <p className="font-bold text-emerald-300">送信完了！ アプリを閉じても大丈夫です</p>
            <p className="mt-0.5 text-xs text-washi/80">
              Google のサーバーで解析が進みます (残り {atServer} 枚)。次にアプリを開いた時に結果を受け取り、図鑑に反映します。
            </p>
          </div>
        </div>
      ) : (
        <div className="mb-4 flex items-start gap-3 rounded-xl bg-gold-500/10 p-3">
          <CheckCircle2 className="mt-0.5 size-6 shrink-0 text-gold-300" />
          <p className="font-bold text-gold-300">すべての解析が終わり、図鑑に反映しました{failed ? ` (失敗 ${failed} 枚)` : ""}</p>
        </div>
      )}

      <ol className="space-y-2.5">
        {steps.map(({ n, icon: Icon, label, detail, ratio }) => {
          const state = n < stage ? "done" : n === stage ? "active" : "todo";
          return (
            <li key={n} className="flex items-center gap-3">
              <span
                className={`grid size-8 shrink-0 place-items-center rounded-full border ${
                  state === "done"
                    ? "border-emerald-500 bg-emerald-500/20 text-emerald-300"
                    : state === "active"
                      ? "border-shu-400 bg-shu-500/20 text-shu-300"
                      : "border-ebony-600 text-ebony-500"
                }`}
              >
                {state === "done" ? <CheckCircle2 className="size-4" /> : <Icon className="size-4" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex justify-between gap-2 text-xs">
                  <span className={state === "todo" ? "text-ebony-500" : "font-bold text-washi"}>
                    {n}. {label}
                    {n === 3 && <span className="ml-1 font-normal text-emerald-300/80">← ここからはアプリを閉じて OK</span>}
                  </span>
                  <span className="shrink-0 text-ash">{detail}</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ebony-800">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${state === "done" ? "bg-emerald-500" : "bg-gradient-to-r from-shu-500 to-gold-300"}`}
                    style={{ width: `${Math.round(Math.min(1, ratio) * 100)}%` }}
                  />
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
