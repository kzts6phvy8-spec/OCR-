import { useEffect, useState } from "react";
import { Eye, EyeOff, HardDrive, KeyRound, Loader2, Share, Smartphone, SquarePlus } from "lucide-react";
import { MODELS, saveSettings, type Settings } from "../lib/settings.ts";
import { useToast } from "../lib/toast.tsx";

const EFFORTS = [
  { id: "low", label: "速い (おすすめ)" },
  { id: "medium", label: "ふつう" },
  { id: "high", label: "じっくり (遅い・やや高い)" },
] as const;

function formatBytes(n: number) {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function SettingsPanel({ settings }: { settings: Settings }) {
  const toast = useToast();
  const [draft, setDraft] = useState(settings);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [storage, setStorage] = useState<{ usage: number; persisted: boolean } | null>(null);
  const standalone =
    typeof window !== "undefined" &&
    (window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);

  useEffect(() => {
    void (async () => {
      const est = await navigator.storage?.estimate?.().catch(() => undefined);
      const persisted = (await navigator.storage?.persisted?.().catch(() => false)) ?? false;
      setStorage({ usage: est?.usage ?? 0, persisted });
    })();
  }, []);

  const save = () => {
    saveSettings({ ...draft, apiKey: draft.apiKey.trim() });
    toast("success", "設定を保存しました");
  };

  const test = async () => {
    setTesting(true);
    try {
      const { testConnection } = await import("../lib/ocr.ts");
      const name = await testConnection({ ...draft, apiKey: draft.apiKey.trim() });
      toast("success", "API キーを確認できました", `${name} を利用できます`);
    } catch (e) {
      toast("error", "API キーを確認できませんでした", (e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const persist = async () => {
    const ok = await navigator.storage?.persist?.().catch(() => false);
    setStorage((s) => (s ? { ...s, persisted: Boolean(ok) } : s));
    toast(ok ? "success" : "warning", ok ? "データが自動削除されないよう設定しました" : "ホーム画面から開くと自動削除されにくくなります");
  };

  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <section className="panel p-5">
        <h2 className="mb-1 flex items-center gap-2 font-serif text-lg font-bold text-gold-400">
          <KeyRound className="size-5" /> Claude API キー
        </h2>
        <p className="mb-4 text-sm text-ash">
          スクショの読み取りに使います。キーはこの iPhone の中にだけ保存され、Anthropic 以外には送信されません。
          <br />
          取得: <span className="text-gold-300">console.anthropic.com</span> → API Keys → Create Key (使った分だけの従量課金)
        </p>
        <div className="flex gap-2">
          <input
            type={showKey ? "text" : "password"}
            className="field font-mono"
            placeholder="sk-ant-..."
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={draft.apiKey}
            onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
          />
          <button onClick={() => setShowKey((v) => !v)} className="rounded-lg border border-ebony-600 px-3 text-ash" aria-label="表示切替">
            {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-bold tracking-wider text-ash">AI モデル</span>
            <select className="field" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })}>
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[11px] text-ebony-500">{MODELS.find((m) => m.id === draft.model)?.note} (目安)</span>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-bold tracking-wider text-ash">読み取りの丁寧さ</span>
            <select className="field" value={draft.effort} onChange={(e) => setDraft({ ...draft, effort: e.target.value as Settings["effort"] })}>
              {EFFORTS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[11px] text-ebony-500">読み間違いが多い時は「ふつう」に</span>
          </label>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <button onClick={save} className="rounded-lg bg-gradient-to-b from-gold-500 to-gold-600 px-5 py-2 font-bold text-ebony-950">
            保存
          </button>
          <button
            onClick={test}
            disabled={!draft.apiKey.trim() || testing}
            className="flex items-center gap-1.5 rounded-lg border border-gold-600/60 px-4 py-2 text-sm font-bold text-gold-400 disabled:opacity-40"
          >
            {testing && <Loader2 className="size-4 animate-spin" />} 接続テスト (無料)
          </button>
        </div>
      </section>

      <section className="panel p-5">
        <h2 className="mb-3 flex items-center gap-2 font-serif text-lg font-bold text-gold-400">
          <Smartphone className="size-5" /> ホーム画面に追加
        </h2>
        {standalone ? (
          <p className="text-sm text-gold-300">ホーム画面のアプリとして起動しています。</p>
        ) : (
          <ol className="space-y-2 text-sm text-ash">
            <li className="flex items-center gap-2">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-ebony-700 text-xs font-bold text-washi">1</span>
              Safari でこのページを開き、下の <Share className="inline size-4 text-sky-400" /> (共有) をタップ
            </li>
            <li className="flex items-center gap-2">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-ebony-700 text-xs font-bold text-washi">2</span>
              <SquarePlus className="inline size-4" /> 「ホーム画面に追加」→「追加」
            </li>
            <li className="flex items-center gap-2">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-ebony-700 text-xs font-bold text-washi">3</span>
              以後はホーム画面の「武将図鑑」アイコンから起動
            </li>
          </ol>
        )}
      </section>

      <section className="panel p-5">
        <h2 className="mb-3 flex items-center gap-2 font-serif text-lg font-bold text-gold-400">
          <HardDrive className="size-5" /> 端末内のデータ
        </h2>
        <p className="text-sm text-ash">
          使用容量: <span className="text-washi">{storage ? formatBytes(storage.usage) : "—"}</span>
          {storage && (
            <span className="ml-3">
              自動削除の保護: <span className={storage.persisted ? "text-gold-300" : "text-ebony-500"}>{storage.persisted ? "有効" : "未設定"}</span>
            </span>
          )}
        </p>
        {storage && !storage.persisted && (
          <button onClick={persist} className="mt-3 rounded-lg border border-ebony-600 px-3 py-1.5 text-xs text-ash hover:text-washi">
            データを自動削除されないようにする
          </button>
        )}
      </section>
    </div>
  );
}
