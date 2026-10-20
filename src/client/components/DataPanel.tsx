import { useRef, useState } from "react";
import { Download, FileJson, Upload } from "lucide-react";
import { api } from "../lib/api.ts";
import { useToast } from "../lib/toast.tsx";

export function DataPanel({ count, onImported }: { count: number; onImported: () => void }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [busy, setBusy] = useState(false);

  const onFile = async (file: File) => {
    setBusy(true);
    try {
      const payload = JSON.parse(await file.text());
      if (mode === "replace" && !confirm("既存の武将データをすべて削除して置き換えます。よろしいですか？")) return;
      const res = await api.importData(payload, mode);
      toast(
        res.errors.length ? "warning" : "success",
        `インポート完了: 新規 ${res.created} 件 / 更新 ${res.updated} 件`,
        res.errors.length ? res.errors.slice(0, 3).join(" / ") : undefined,
      );
      onImported();
    } catch (e) {
      toast("error", "インポートに失敗しました", e instanceof SyntaxError ? "JSON ファイルを読み込めませんでした" : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <section className="panel p-5">
        <h2 className="mb-1 flex items-center gap-2 font-serif text-lg font-bold text-gold-400">
          <Download className="size-5" /> エクスポート
        </h2>
        <p className="mb-4 text-sm text-ash">登録済みの全武将 ({count} 件) を JSON ファイルとしてダウンロードします。画像は URL として含まれます。</p>
        <a
          href="/api/export"
          download
          className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-b from-gold-500 to-gold-600 px-4 py-2 font-bold text-ebony-950"
        >
          <FileJson className="size-4" /> JSON をダウンロード
        </a>
      </section>

      <section className="panel p-5">
        <h2 className="mb-1 flex items-center gap-2 font-serif text-lg font-bold text-gold-400">
          <Upload className="size-5" /> インポート
        </h2>
        <p className="mb-4 text-sm text-ash">エクスポートした JSON を読み込みます。武将は「武将名 + 通常/特異」で照合されます。</p>
        <div className="mb-4 space-y-2 text-sm">
          <label className="flex cursor-pointer items-center gap-2">
            <input type="radio" checked={mode === "merge"} onChange={() => setMode("merge")} className="accent-gold-500" />
            追加・上書き (同じ武将はファイルの内容で更新)
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-hi-400">
            <input type="radio" checked={mode === "replace"} onChange={() => setMode("replace")} className="accent-hi-500" />
            全置換 (既存データを削除してから読み込み)
          </label>
        </div>
        <button
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className="inline-flex items-center gap-2 rounded-lg border border-gold-600/60 px-4 py-2 font-bold text-gold-400 hover:bg-gold-500/10 disabled:opacity-50"
        >
          <Upload className="size-4" /> JSON ファイルを選択
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
            e.target.value = "";
          }}
        />
      </section>
    </div>
  );
}
