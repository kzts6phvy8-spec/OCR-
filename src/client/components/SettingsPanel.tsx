import { useEffect, useState } from "react";
import { Cloud, Copy, Eye, EyeOff, HardDrive, KeyRound, Loader2, Share, Smartphone, SquarePlus } from "lucide-react";
import { CLAUDE_MODELS, DEFAULT_GEMINI_MODEL, newToken, saveSettings, type Settings } from "../lib/settings.ts";
import { callServer } from "../lib/remote.ts";
import { getServerVersion, refreshServerStatus } from "../lib/queue.ts";
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

/** エラー文中の URL をタップできるリンクにして表示する */
function ErrorWithLinks({ text }: { text: string }) {
  const parts = text.split(/(https:\/\/[^\s]+)/);
  return (
    <p className="mt-3 rounded-lg border border-hi-600/60 bg-hi-800/30 p-3 text-sm break-all text-hi-400">
      {parts.map((part, i) =>
        part.startsWith("https://") ? (
          <a key={i} href={part} target="_blank" rel="noreferrer" className="font-bold text-sky-300 underline">
            {part}
          </a>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </p>
  );
}

function KeyInput({ value, placeholder, onChange }: { value: string; placeholder: string; onChange: (v: string) => void }) {
  const [show, setShow] = useState(false);
  return (
    <div className="flex gap-2">
      <input
        type={show ? "text" : "password"}
        className="field font-mono"
        placeholder={placeholder}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button onClick={() => setShow((v) => !v)} className="rounded-lg border border-ebony-600 px-3 text-ash" aria-label="表示切替">
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

export function SettingsPanel({ settings }: { settings: Settings }) {
  const toast = useToast();
  const [draft, setDraft] = useState(settings);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
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

  const clean = (d: Settings): Settings => ({ ...d, apiKey: d.apiKey.trim(), geminiKey: d.geminiKey.trim() });

  const save = () => {
    saveSettings(clean(draft));
    toast("success", "設定を保存しました");
  };

  const test = async () => {
    setTesting(true);
    setTestError(null);
    const d = clean(draft);
    try {
      if (d.provider === "gemini") {
        const { testConnection } = await import("../lib/gemini.ts");
        const models = await testConnection(d);
        // 使えるモデルの一覧を保存し、選択中のモデルが無ければ Flash の最新を選ぶ
        const pick =
          models.includes(d.geminiModel) || models.length === 0
            ? d.geminiModel
            : (models.find((m) => m === DEFAULT_GEMINI_MODEL) ?? models.find((m) => /flash/i.test(m) && !/lite/i.test(m)) ?? models[0]);
        const next = { ...d, geminiModels: models, geminiModel: pick };
        setDraft(next);
        saveSettings(next);
        toast("success", "API キーを確認できました", `${models.length} 種類のモデルが使えます (選択中: ${pick})`);
      } else {
        const { testConnection } = await import("../lib/ocr.ts");
        const name = await testConnection(d);
        saveSettings(d);
        toast("success", "API キーを確認できました", `${name} を利用できます`);
      }
    } catch (e) {
      toast("error", "API キーを確認できませんでした", (e as Error).message);
      setTestError((e as Error).message);
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
        <h2 className="mb-3 flex items-center gap-2 font-serif text-lg font-bold text-gold-400">
          <KeyRound className="size-5" /> 読み取りに使う AI
        </h2>
        <div className="mb-4 grid grid-cols-2 gap-2">
          {(
            [
              ["gemini", "Gemini (Google)", "無料枠あり"],
              ["claude", "Claude (Anthropic)", "有料・高精度"],
            ] as const
          ).map(([id, label, note]) => (
            <button
              key={id}
              onClick={() => setDraft({ ...draft, provider: id })}
              className={`rounded-xl border px-3 py-2.5 text-left transition ${
                draft.provider === id ? "border-shu-400 bg-shu-500/15" : "border-ebony-600"
              }`}
            >
              <span className={`block text-sm font-bold ${draft.provider === id ? "text-shu-300" : ""}`}>{label}</span>
              <span className="block text-[11px] text-ash">{note}</span>
            </button>
          ))}
        </div>

        {draft.provider === "gemini" ? (
          <>
            <p className="mb-3 text-sm text-ash">
              Google AI Studio (<span className="text-gold-300">aistudio.google.com</span>) → 「Get API key」→「Create API key」で取得できます。
              無料枠の範囲なら料金はかかりません (1 日・1 分あたりの回数制限あり。上限に達すると少し待ってから自動で再試行します)。
              <br />
              <span className="text-[11px] text-ebony-500">※ 無料枠では、送った画像が Google のサービス改善に使われることがあります。</span>
            </p>
            <KeyInput value={draft.geminiKey} placeholder="AIza..." onChange={(v) => setDraft({ ...draft, geminiKey: v })} />
            <label className="mt-4 block">
              <span className="mb-1 block text-xs font-bold tracking-wider text-ash">AI モデル</span>
              <select className="field" value={draft.geminiModel} onChange={(e) => setDraft({ ...draft, geminiModel: e.target.value })}>
                {[...new Set([DEFAULT_GEMINI_MODEL, draft.geminiModel, ...draft.geminiModels])].map((m) => (
                  <option key={m} value={m}>
                    {m === DEFAULT_GEMINI_MODEL ? `${m} (最新の Flash・おすすめ)` : m}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[11px] text-ebony-500">「接続テスト」を押すと、このキーで使えるモデルが一覧に追加されます。Pro 系は無料枠外のことがあります</span>
            </label>
          </>
        ) : (
          <>
            <p className="mb-3 text-sm text-ash">
              <span className="text-gold-300">console.anthropic.com</span> → API Keys → Create Key で取得できます。
              <span className="text-hi-400">事前のチャージ (前払い) が必要な有料サービス</span>です。
            </p>
            <KeyInput value={draft.apiKey} placeholder="sk-ant-..." onChange={(v) => setDraft({ ...draft, apiKey: v })} />
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs font-bold tracking-wider text-ash">AI モデル</span>
                <select className="field" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })}>
                  {CLAUDE_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <span className="mt-1 block text-[11px] text-ebony-500">{CLAUDE_MODELS.find((m) => m.id === draft.model)?.note} (目安)</span>
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
          </>
        )}
        <p className="mt-3 text-[11px] text-ebony-500">キーはこの iPhone の中にだけ保存され、選んだ AI の会社以外には送信されません。</p>

        <div className="mt-5 flex flex-wrap gap-2">
          <button onClick={save} className="rounded-lg bg-gradient-to-b from-shu-400 to-shu-600 px-5 py-2 font-bold text-white">
            保存
          </button>
          <button
            onClick={test}
            disabled={!(draft.provider === "gemini" ? draft.geminiKey : draft.apiKey).trim() || testing}
            className="flex items-center gap-1.5 rounded-lg border border-gold-600/60 px-4 py-2 text-sm font-bold text-gold-400 disabled:opacity-40"
          >
            {testing && <Loader2 className="size-4 animate-spin" />} 接続テスト (無料)
          </button>
        </div>
        {testError && <ErrorWithLinks text={testError} />}
      </section>

      <BackgroundSection draft={draft} setDraft={setDraft} />

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

const SETUP_STEPS = [
  "下の「サーバー用コードをコピー」を押す",
  "Safari で script.google.com を開き (Gemini のキーを作った Google アカウントで)、「新しいプロジェクト」を押す。画面が見づらい時は「ぁあ」→「デスクトップ用 Web サイトを表示」",
  "最初から書いてあるコードをすべて消して、コピーしたコードを貼り付け、保存 (フロッピーのマーク) を押す",
  "上の関数の選択欄で「setup」を選んで「実行」を押す → 「権限を確認」→ アカウントを選ぶ →「詳細」→「(プロジェクト名) に移動」→「許可」",
  "右上の「デプロイ」→「新しいデプロイ」→ 種類の選択 (歯車) で「ウェブアプリ」→「次のユーザーとして実行: 自分」「アクセスできるユーザー: 全員」→「デプロイ」",
  "表示された「ウェブアプリの URL」(https://script.google.com/macros/s/… で始まる) をコピーして、下の欄に貼り付ける",
  "「接続テスト」を押す (Gemini のキーと合言葉が自動でサーバーに登録されます)",
];

function BackgroundSection({ draft, setDraft }: { draft: Settings; setDraft: (s: Settings) => void }) {
  const toast = useToast();
  const [code, setCode] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [version, setVersion] = useState(getServerVersion());
  const LATEST = 3;

  useEffect(() => {
    if (!draft.bgUrl || !draft.bgToken) return;
    void refreshServerStatus().then(() => setVersion(getServerVersion()));
  }, [draft.bgUrl, draft.bgToken]);

  // iPhone ではボタンを押した瞬間にコピーする必要があるので、先に読み込んでおく
  useEffect(() => {
    fetch("./apps-script.gs")
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then(setCode, () => setCode(null));
  }, []);

  const copyCode = async () => {
    if (!code) return toast("error", "コードを読み込めませんでした。電波状況を確認してください");
    try {
      await navigator.clipboard.writeText(code);
      toast("success", "サーバー用コードをコピーしました", `${code.split("\n").length} 行`);
    } catch {
      setShowCode(true);
      toast("warning", "自動でコピーできませんでした", "下に表示したコードを長押しして「すべてを選択」→「コピー」してください");
    }
  };

  const test = async () => {
    setTesting(true);
    setMessage(null);
    const next: Settings = { ...draft, bgUrl: draft.bgUrl.trim(), bgToken: draft.bgToken || newToken(), bgEnabled: true };
    try {
      if (!next.geminiKey.trim()) throw new Error("先に上で Gemini の API キーを登録してください");
      if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(next.bgUrl)) {
        throw new Error("URL は https://script.google.com/macros/s/… で始まるウェブアプリの URL を貼り付けてください");
      }
      const res = await callServer<{ version?: number }>(next, "config", { geminiKey: next.geminiKey.trim() });
      setVersion(res.version ?? 1);
      setDraft(next);
      saveSettings(next);
      void refreshServerStatus();
      setMessage({ ok: true, text: `つながりました。バックグラウンド解析をオンにしました (サーバーの解析待ち ${res.pending ?? 0} 枚)` });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const toggle = (on: boolean) => {
    const next = { ...draft, bgEnabled: on };
    setDraft(next);
    saveSettings(next);
    toast("info", on ? "バックグラウンド解析をオンにしました" : "バックグラウンド解析をオフにしました", on ? undefined : "これからの解析は、この iPhone で直接行います");
  };

  return (
    <section className="panel p-5">
      <h2 className="mb-1 flex items-center gap-2 font-serif text-lg font-bold text-gold-400">
        <Cloud className="size-5" /> バックグラウンド解析
      </h2>
      <p className="mb-3 text-sm text-ash">
        あなたの Google アカウントの中で無料で動く「Google Apps Script」を解析サーバーとして使い、
        <span className="text-washi">アプリを閉じていても解析を進めます</span>。写真をサーバーに送る間だけアプリを開いておき、結果は次に開いた時に受け取ります。
      </p>
      {draft.provider !== "gemini" ? (
        <p className="text-sm text-amber-300">読み取りに使う AI で「Gemini」を選んだ時だけ使えます。</p>
      ) : (
        <>
          {draft.bgUrl && draft.bgToken && (
            <label className="mb-4 flex cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.bgEnabled} onChange={(e) => toggle(e.target.checked)} className="size-4 accent-shu-500" />
              バックグラウンド解析を使う
            </label>
          )}
          <details className="mb-4 rounded-lg border border-ebony-700 bg-ebony-900 p-3" open={!draft.bgUrl}>
            <summary className="cursor-pointer text-sm font-bold text-washi">はじめての準備 (1 回だけ)</summary>
            <ol className="mt-3 space-y-2 text-sm text-ash">
              {SETUP_STEPS.map((step, i) => (
                <li key={i} className="flex gap-2">
                  <span className="grid size-5 shrink-0 place-items-center rounded-full bg-ebony-700 text-[11px] font-bold text-washi">{i + 1}</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
            <button
              onClick={copyCode}
              className="mt-3 flex items-center gap-1.5 rounded-lg border border-gold-600/60 px-3 py-1.5 text-sm font-bold text-gold-400"
            >
              <Copy className="size-4" /> サーバー用コードをコピー
            </button>
            {showCode && code && <textarea readOnly value={code} rows={8} className="field mt-2 font-mono text-[10px]" />}
          </details>
          <input
            className="field font-mono text-xs"
            placeholder="https://script.google.com/macros/s/…/exec"
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
            value={draft.bgUrl}
            onChange={(e) => setDraft({ ...draft, bgUrl: e.target.value })}
          />
          <button
            onClick={test}
            disabled={!draft.bgUrl.trim() || testing}
            className="mt-3 flex items-center gap-1.5 rounded-lg border border-gold-600/60 px-4 py-2 text-sm font-bold text-gold-400 disabled:opacity-40"
          >
            {testing && <Loader2 className="size-4 animate-spin" />} 接続テスト
          </button>
          {version > 0 && version < LATEST && (
            <div className="mt-4 rounded-lg border border-amber-500/50 bg-amber-900/20 p-3 text-sm text-amber-200">
              <p className="font-bold">サーバーのコードを更新すると、解析が速くなります (今: 版 {version} → 最新: 版 {LATEST})</p>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-amber-100/90">
                <li>上の「サーバー用コードをコピー」を押す</li>
                <li>iPad などで script.google.com のプロジェクトを開き、コードをすべて消して貼り付け、保存</li>
                <li>「デプロイ」→「デプロイを管理」→ 鉛筆マーク →「バージョン」で「新バージョン」→「デプロイ」(URL は変わりません)</li>
              </ol>
              <p className="mt-2 text-xs text-amber-100/70">更新しなくても今まで通り使えます。更新すると、送信後すぐに解析が始まり (版 2〜)、無料枠の上限に達した時にその理由と再開の時刻が表示されるようになります (版 3)。</p>
            </div>
          )}
          {version >= LATEST && <p className="mt-3 text-xs text-emerald-300">サーバーは最新版 (版 {version}) です。</p>}
          {message &&
            (message.ok ? (
              <p className="mt-3 rounded-lg border border-emerald-700/60 bg-emerald-900/20 p-3 text-sm text-emerald-300">{message.text}</p>
            ) : (
              <ErrorWithLinks text={message.text} />
            ))}
        </>
      )}
    </section>
  );
}
