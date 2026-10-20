import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, BookOpen, Database, ScanLine, Settings as SettingsIcon } from "lucide-react";
import type { OcrJob, Warlord } from "../core/types.ts";
import { api } from "./lib/api.ts";
import { onQueueChange, resumeQueue } from "./lib/queue.ts";
import { loadSettings, onSettingsChange, type Settings } from "./lib/settings.ts";
import { useToast } from "./lib/toast.tsx";
import { UploadPanel } from "./components/UploadPanel.tsx";
import { WarlordGrid } from "./components/WarlordGrid.tsx";
import { WarlordDetail } from "./components/WarlordDetail.tsx";
import { DataPanel } from "./components/DataPanel.tsx";
import { SettingsPanel } from "./components/SettingsPanel.tsx";

type Tab = "zukan" | "upload" | "data" | "settings";

const TABS: { id: Tab; label: string; icon: typeof BookOpen }[] = [
  { id: "zukan", label: "武将図鑑", icon: BookOpen },
  { id: "upload", label: "スクショ解析", icon: ScanLine },
  { id: "data", label: "データ管理", icon: Database },
  { id: "settings", label: "設定", icon: SettingsIcon },
];

export default function App() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("zukan");
  const [warlords, setWarlords] = useState<Warlord[]>([]);
  const [loading, setLoading] = useState(true);
  const [jobs, setJobs] = useState<OcrJob[]>([]);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const knownStatus = useRef<Map<string, OcrJob["status"]> | null>(null);

  const refreshWarlords = useCallback(async () => {
    try {
      setWarlords(await api.warlords());
    } catch (e) {
      toast("error", "武将一覧の読み込みに失敗しました", (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const refreshJobs = useCallback(async () => {
    const list = await api.jobs();
    // 状態が変わったジョブをトーストで通知する
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
    void refreshJobs().then(() => resumeQueue());
    const offQueue = onQueueChange(() => void refreshJobs());
    const offSettings = onSettingsChange(setSettings);
    return () => {
      offQueue();
      offSettings();
    };
  }, [refreshWarlords, refreshJobs]);

  const openWarlord = warlords.find((w) => w.id === openId) ?? null;
  const activeCount = jobs.filter((j) => j.status === "queued" || j.status === "processing").length;

  const badge = (id: Tab) =>
    id === "upload" && activeCount > 0 ? (
      <span className="absolute -top-1.5 -right-1.5 grid min-w-5 place-items-center rounded-full bg-hi-500 px-1 text-[10px] font-bold text-white">
        {activeCount}
      </span>
    ) : null;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-ebony-700/80 bg-ebony-950/85 pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-x-6 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-md border border-gold-600/60 bg-gradient-to-b from-hi-600 to-hi-800 font-serif text-xl font-extrabold text-gold-300 shadow-lg">
              武
            </div>
            <div className="leading-tight">
              <h1 className="gold-text font-serif text-xl font-extrabold tracking-wider">戦国布武 武将図鑑</h1>
              <p className="text-[11px] tracking-widest text-ash">AI スクリーンショット解析</p>
            </div>
          </div>
          <nav className="ml-auto hidden gap-1 rounded-lg border border-ebony-700 bg-ebony-900 p-1 sm:flex">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`relative flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  tab === id ? "bg-gradient-to-b from-gold-500 to-gold-600 text-ebony-950 shadow" : "text-ash hover:bg-ebony-800 hover:text-washi"
                }`}
              >
                <Icon className="size-4" />
                {label}
                {badge(id)}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {!settings.apiKey && tab !== "settings" && (
        <div className="mx-auto mt-4 w-full max-w-7xl px-4">
          <button
            onClick={() => setTab("settings")}
            className="flex w-full items-center gap-2 rounded-lg border border-hi-600/60 bg-hi-800/40 px-4 py-2 text-left text-sm text-hi-400"
          >
            <AlertTriangle className="size-4 shrink-0" />
            AI 解析を使うには Claude API キーの登録が必要です。タップして設定 →
          </button>
        </div>
      )}

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 pt-6 pb-[calc(5.5rem+env(safe-area-inset-bottom))] sm:pb-6">
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
          <UploadPanel jobs={jobs} warlords={warlords} model={settings.model} hasApiKey={Boolean(settings.apiKey)} onOpenWarlord={setOpenId} />
        )}
        {tab === "data" && <DataPanel count={warlords.length} onImported={refreshWarlords} />}
        {tab === "settings" && <SettingsPanel settings={settings} />}
      </main>

      {/* iPhone 用の下部タブバー */}
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-ebony-700 bg-ebony-950/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex flex-col items-center gap-0.5 py-2 text-[10px] ${tab === id ? "text-gold-400" : "text-ash"}`}
          >
            <span className="relative">
              <Icon className="size-6" />
              {badge(id)}
            </span>
            {label}
          </button>
        ))}
      </nav>

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
