import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, Database, ScanLine, AlertTriangle } from "lucide-react";
import type { HealthInfo, OcrJob, Warlord } from "../shared/types.ts";
import { api } from "./lib/api.ts";
import { useToast } from "./lib/toast.tsx";
import { UploadPanel } from "./components/UploadPanel.tsx";
import { WarlordGrid } from "./components/WarlordGrid.tsx";
import { WarlordDetail } from "./components/WarlordDetail.tsx";
import { DataPanel } from "./components/DataPanel.tsx";

type Tab = "zukan" | "upload" | "data";

const TABS: { id: Tab; label: string; icon: typeof BookOpen }[] = [
  { id: "zukan", label: "武将図鑑", icon: BookOpen },
  { id: "upload", label: "スクショ解析", icon: ScanLine },
  { id: "data", label: "データ管理", icon: Database },
];

export default function App() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("zukan");
  const [warlords, setWarlords] = useState<Warlord[]>([]);
  const [loading, setLoading] = useState(true);
  const [jobs, setJobs] = useState<OcrJob[]>([]);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const knownStatus = useRef<Map<string, OcrJob["status"]> | null>(null);

  const refreshWarlords = useCallback(async () => {
    try {
      setWarlords(await api.warlords());
    } catch (e) {
      toast("error", "武将一覧の取得に失敗しました", (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const refreshJobs = useCallback(async () => {
    let list: OcrJob[];
    try {
      list = await api.jobs();
    } catch {
      return;
    }
    // 初回以外は、状態が変わったジョブをトーストで通知する
    const prev = knownStatus.current;
    let changed = false;
    if (prev) {
      for (const job of list) {
        const before = prev.get(job.id);
        const finished = job.status === "done" || job.status === "error";
        if (before === undefined || before === job.status || !finished) continue;
        changed = true;
        if (job.status === "done") {
          toast(
            job.warnings.length ? "warning" : "success",
            `${job.warlord_label} を${job.merged ? "統合更新" : "新規登録"}しました`,
            job.warnings.length ? job.warnings.join(" / ") : job.file_name,
          );
        } else {
          toast("error", `解析失敗: ${job.file_name}`, job.error ?? undefined);
        }
      }
    }
    knownStatus.current = new Map(list.map((j) => [j.id, j.status]));
    setJobs(list);
    if (changed) void refreshWarlords();
  }, [refreshWarlords, toast]);

  useEffect(() => {
    void refreshWarlords();
    void refreshJobs();
    api.health().then(setHealth, () => setHealth(null));
  }, [refreshWarlords, refreshJobs]);

  // 解析中のジョブがある間だけ短い間隔でポーリング
  const active = jobs.some((j) => j.status === "queued" || j.status === "processing");
  useEffect(() => {
    const timer = setInterval(() => void refreshJobs(), active ? 1500 : 15000);
    return () => clearInterval(timer);
  }, [active, refreshJobs]);

  const openWarlord = warlords.find((w) => w.id === openId) ?? null;
  const activeCount = jobs.filter((j) => j.status === "queued" || j.status === "processing").length;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-ebony-700/80 bg-ebony-950/85 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-md border border-gold-600/60 bg-gradient-to-b from-hi-600 to-hi-800 font-serif text-xl font-extrabold text-gold-300 shadow-lg">
              武
            </div>
            <div className="leading-tight">
              <h1 className="gold-text font-serif text-xl font-extrabold tracking-wider">戦国布武 武将図鑑</h1>
              <p className="text-[11px] tracking-widest text-ash">AI スクリーンショット解析データベース</p>
            </div>
          </div>
          <nav className="ml-auto flex gap-1 rounded-lg border border-ebony-700 bg-ebony-900 p-1">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`relative flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  tab === id ? "bg-gradient-to-b from-gold-500 to-gold-600 text-ebony-950 shadow" : "text-ash hover:bg-ebony-800 hover:text-washi"
                }`}
              >
                <Icon className="size-4" />
                <span className="hidden sm:inline">{label}</span>
                {id === "upload" && activeCount > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 grid min-w-5 place-items-center rounded-full bg-hi-500 px-1 text-[10px] font-bold text-white">
                    {activeCount}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {health && !health.api_key_configured && (
        <div className="mx-auto mt-4 flex w-full max-w-7xl items-center gap-2 px-4">
          <div className="flex w-full items-center gap-2 rounded-lg border border-hi-600/60 bg-hi-800/40 px-4 py-2 text-sm text-hi-400">
            <AlertTriangle className="size-4 shrink-0" />
            ANTHROPIC_API_KEY が未設定のため OCR 解析は実行できません。.env を設定してサーバーを再起動してください。
          </div>
        </div>
      )}

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        {tab === "zukan" && (
          <WarlordGrid
            warlords={warlords}
            loading={loading}
            onOpen={setOpenId}
            onCreate={() => setCreating(true)}
            onGoUpload={() => setTab("upload")}
          />
        )}
        {tab === "upload" && (
          <UploadPanel
            jobs={jobs}
            warlords={warlords}
            model={health?.model}
            onUploaded={(created) => {
              for (const j of created) knownStatus.current?.set(j.id, j.status);
              void refreshJobs();
            }}
            onOpenWarlord={setOpenId}
          />
        )}
        {tab === "data" && <DataPanel count={warlords.length} onImported={refreshWarlords} />}
      </main>

      <footer className="border-t border-ebony-800 py-4 text-center text-[11px] text-ebony-500">
        戦国布武 武将図鑑 — 非公式ファンツール
      </footer>

      {(openWarlord || creating) && (
        <WarlordDetail
          warlord={creating ? null : openWarlord}
          allWarlords={warlords}
          onClose={() => {
            setOpenId(null);
            setCreating(false);
          }}
          onSaved={(w) => {
            setCreating(false);
            setOpenId(w.id);
            void refreshWarlords();
          }}
          onDeleted={() => {
            setOpenId(null);
            void refreshWarlords();
          }}
          onOpenOther={(id) => {
            setCreating(false);
            setOpenId(id);
          }}
        />
      )}
    </div>
  );
}
