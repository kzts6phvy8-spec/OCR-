import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, BookOpen, Database, Download, Save, ScanLine, Settings as SettingsIcon, Upload } from "lucide-react";
import { isPending, type OcrJob, type Warlord } from "../core/types.ts";
import { api } from "./lib/api.ts";
import { onQueueChange, resumeQueue } from "./lib/queue.ts";
import { activeModelLabel, bgActive, hasActiveKey, loadSettings, onSettingsChange, type Settings } from "./lib/settings.ts";
import { useToast } from "./lib/toast.tsx";
import { saveFile, today } from "./lib/share.ts";
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
  const sendingRef = useRef(0);

  const refreshWarlords = useCallback(async () => {
    try {
      setWarlords(await api.warlords());
    } catch (e) {
      toast("error", "武将一覧の読み込みに失敗しました", (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  // バッチ (未完了が 0 になるまで) の集計。大量に解析してもトーストが溢れないよう、まとめて通知する
  const batchStats = useRef({ done: 0, merged: 0, failed: 0, warnings: 0 });

  const refreshJobs = useCallback(async () => {
    const list = await api.jobs();
    const prev = knownStatus.current;
    let changed = false;
    if (prev) {
      const stats = batchStats.current;
      const finishedNow: OcrJob[] = [];
      for (const job of list) {
        const before = prev.get(job.id);
        const finished = job.status === "done" || job.status === "error";
        if (before === undefined || before === job.status || !finished) continue;
        changed = true;
        finishedNow.push(job);
        if (job.status === "done") {
          stats.done++;
          if (job.merged) stats.merged++;
          if (job.warnings.length) stats.warnings++;
        } else stats.failed++;
      }
      // 少ない枚数なら 1 枚ずつ、多ければ失敗だけを知らせる
      const pending = list.filter((j) => isPending(j.status)).length;
      for (const job of finishedNow) {
        if (job.status === "error") {
          if (stats.failed <= 3) toast("error", `解析失敗: ${job.file_name}`, job.error ?? undefined);
        }
        else if (pending + finishedNow.length <= 3 && stats.done <= 3) {
          toast(
            job.warnings.length ? "warning" : "success",
            `${job.warlord_label} を${job.merged ? "統合更新" : "新規登録"}しました`,
            job.warnings.length ? job.warnings.join(" / ") : job.file_name,
          );
        }
      }
      if (pending === 0 && stats.done + stats.failed > 0 && finishedNow.length > 0) {
        toast(
          stats.failed ? "warning" : "success",
          `解析が完了しました (${stats.done + stats.failed} 枚)`,
          `成功 ${stats.done} 枚 (うち統合 ${stats.merged}) / 失敗 ${stats.failed} 枚${stats.warnings ? ` / 要確認 ${stats.warnings} 枚` : ""}`,
        );
        batchStats.current = { done: 0, merged: 0, failed: 0, warnings: 0 };
      }
    }
    // バックグラウンド解析: サーバーへの送信が終わった瞬間を知らせる (ここからはアプリを閉じてよい)
    const sendingNow = list.filter((j) => j.status === "queued" || j.status === "processing").length;
    const remoteNow = list.filter((j) => j.status === "remote").length;
    if (bgActive(loadSettings()) && sendingRef.current > 0 && sendingNow === 0 && remoteNow > 0) {
      toast("success", "送信完了！ アプリを閉じても大丈夫です", `サーバーで ${remoteNow} 枚を解析中。次に開いた時に結果を受け取ります`);
    }
    sendingRef.current = sendingNow;
    knownStatus.current = new Map(list.map((j) => [j.id, j.status]));
    setJobs(list);
    if (changed) void refreshWarlords();
  }, [refreshWarlords, toast]);

  useEffect(() => {
    // 古い表記の優先度を、覚醒スキルの発動条件から新しい表記 (甲・1 など) に直す
    void api.fillPriorities().then(({ updated, unmatched }) => {
      if (updated === 0) return;
      toast(
        "success",
        `${updated} 人の覚醒スキルの優先度を、発動条件から新しい表記に直しました`,
        unmatched ? `発動条件が一覧に無かった ${unmatched} 人は、そのままです (武将の編集画面で直せます)` : undefined,
      );
      void refreshWarlords();
    });
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

  const exportTxt = async () => {
    if (warlords.length === 0) return toast("info", "まだ武将が登録されていません");
    await saveFile(await api.exportText(), `warlords-${today()}.txt`, "戦国布武 武将図鑑");
  };
  const backup = async () => {
    // 武将が多いと画像込みでは巨大になるため、100 件を超えたら画像なし (画像込みはデータ管理から選べる)
    await saveFile(await api.exportData(warlords.length <= 100), `warlords-${today()}.json`, "戦国布武 武将図鑑 バックアップ");
  };

  const openWarlord = warlords.find((w) => w.id === openId) ?? null;
  const activeCount = jobs.filter((j) => isPending(j.status)).length;

  const badge = (id: Tab) =>
    id === "upload" && activeCount > 0 ? (
      <span className="absolute -top-1.5 -right-1.5 grid min-w-5 place-items-center rounded-full bg-hi-500 px-1 text-[10px] font-bold text-white">
        {activeCount}
      </span>
    ) : null;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-ebony-700/80 bg-ebony-950/85 pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-x-3 px-4 py-3 sm:gap-x-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid size-10 place-items-center rounded-md border border-gold-600/60 bg-gradient-to-b from-hi-600 to-hi-800 font-serif text-xl font-extrabold text-gold-300 shadow-lg">
              武
            </div>
            <div className="leading-tight">
              <h1 className="gold-text font-serif text-lg font-extrabold tracking-wider whitespace-nowrap sm:text-xl">武将図鑑</h1>
              <p className="text-[11px] whitespace-nowrap text-ash">
                <span className="font-bold text-shu-300">{warlords.length}</span> 件保存済
              </p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-1.5 sm:order-last sm:ml-0">
            <button
              onClick={exportTxt}
              className="flex items-center gap-1 rounded-xl bg-gradient-to-b from-shu-400 to-shu-600 px-3 py-2 text-sm font-bold text-white"
              title="全武将をテキストで保存"
            >
              <Download className="size-4" /> .txt
            </button>
            <button onClick={backup} className="rounded-xl border border-ebony-600 p-2 text-gold-400" title="バックアップを保存" aria-label="バックアップを保存">
              <Save className="size-5" />
            </button>
            <button onClick={() => setTab("data")} className="rounded-xl border border-ebony-600 p-2 text-ash" title="バックアップから復元" aria-label="バックアップから復元">
              <Upload className="size-5" />
            </button>
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

      {!hasActiveKey(settings) && tab !== "settings" && (
        <div className="mx-auto mt-4 w-full max-w-7xl px-4">
          <button
            onClick={() => setTab("settings")}
            className="flex w-full items-center gap-2 rounded-lg border border-hi-600/60 bg-hi-800/40 px-4 py-2 text-left text-sm text-hi-400"
          >
            <AlertTriangle className="size-4 shrink-0" />
            AI 解析を使うには API キーの登録が必要です (Gemini なら無料枠あり)。タップして設定 →
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
            onChanged={refreshWarlords}
          />
        )}
        {tab === "upload" && (
          <UploadPanel jobs={jobs} warlords={warlords} model={activeModelLabel(settings)} hasApiKey={hasActiveKey(settings)} onOpenWarlord={setOpenId} />
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
