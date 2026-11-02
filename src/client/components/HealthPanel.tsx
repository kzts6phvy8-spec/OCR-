import { useState } from "react";
import { CheckCircle2, ClipboardCopy, Loader2, Merge, ShieldCheck, Split, Trash2, TriangleAlert } from "lucide-react";
import { api, lastHealthReport, type HealthReport } from "../lib/api.ts";
import { clearErrorLog, getErrorLog } from "../lib/errorLog.ts";
import { useToast } from "../lib/toast.tsx";
import type { Warlord } from "../../core/types.ts";

// 「データ管理」の自動点検: 起動のたびに図鑑データを点検し、直せるものは直す。
// 直せないものはここに並べ、点検結果とエラーの記録をコピーして送れるようにする。

export function HealthPanel({
  warlords,
  onChanged,
  onOpenWarlord,
}: {
  warlords: Warlord[];
  onChanged: () => void;
  onOpenWarlord: (id: string) => void;
}) {
  const toast = useToast();
  const [report, setReport] = useState<HealthReport | null>(lastHealthReport);
  const [busy, setBusy] = useState(false);
  const [errorCount, setErrorCount] = useState(() => getErrorLog().length);
  const byId = new Map(warlords.map((w) => [w.id, w]));

  const run = async () => {
    setBusy(true);
    try {
      const r = await api.runHealthCheck();
      setReport(r);
      onChanged();
      toast(r.warnings.length ? "warning" : "success", `点検しました: 自動で直した ${r.fixed.length} 件 / 確かめてほしい ${r.warnings.length} 件`);
    } catch (e) {
      toast("error", "点検できませんでした", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(await api.healthReportText());
      toast("success", "点検結果とエラーの記録をコピーしました", "Claude との会話に貼り付けて送ってください");
    } catch {
      toast("error", "コピーできませんでした");
    }
  };

  const mergeGroup = async (ids: string[]) => {
    const [keep, ...rest] = ids.map((id) => byId.get(id)).filter((w): w is Warlord => Boolean(w));
    if (!keep || rest.length === 0) return;
    if (!confirm(`「${keep.name}」の ${ids.length} 人を 1 人にまとめますか？\n立ち絵が違う別の武将 (通常と特異など) の時は、まとめないでください。`)) return;
    try {
      for (const w of rest) await api.mergeWarlords(keep.id, w.id);
      toast("success", `「${keep.name}」をまとめました`);
    } catch (e) {
      toast("error", "まとめられませんでした", (e as Error).message);
    }
    await run();
  };

  const split = async (id: string) => {
    const w = byId.get(id);
    if (!w || !confirm(`「${w.name}」の画像を立ち絵ごとに分けますか？\n画像がいちばん多い立ち絵をこの武将に残し、違う立ち絵の画像は別の武将に統合し直します。`)) return;
    try {
      const r = await api.splitWarlord(id);
      toast(r.groups ? "success" : "info", r.groups ? `${r.groups} 組に分けます (${r.jobs} 枚)` : "確かめたところ、同じ立ち絵でした (分けませんでした)");
      await run();
    } catch (e) {
      toast("error", "分けられませんでした", (e as Error).message);
    }
  };

  return (
    <section className="panel p-5 md:col-span-2">
      <h2 className="mb-1 flex items-center gap-2 font-serif text-lg font-bold text-gold-400">
        <ShieldCheck className="size-5" /> 自動点検
      </h2>
      <p className="mb-3 text-sm text-ash">
        アプリを開くたびに図鑑データを点検し、安全に直せるもの (連携スキルの重なり・使われていない画像など) は自動で直します。
        読み違いの疑いなど、自動では直せないものはここに並びます。
      </p>
      <div className="mb-3 flex flex-wrap gap-2">
        <button onClick={run} disabled={busy} className="flex items-center gap-1.5 rounded-lg border border-gold-600/60 px-3 py-1.5 text-sm font-bold text-gold-400 disabled:opacity-40">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />} 今すぐ点検
        </button>
        <button onClick={copy} className="flex items-center gap-1.5 rounded-lg border border-ebony-600 px-3 py-1.5 text-sm text-ash">
          <ClipboardCopy className="size-4" /> 点検結果とエラーの記録をコピー
        </button>
        {errorCount > 0 && (
          <button
            onClick={() => {
              clearErrorLog();
              setErrorCount(0);
              toast("info", "エラーの記録を消しました");
            }}
            className="flex items-center gap-1.5 rounded-lg border border-ebony-600 px-3 py-1.5 text-sm text-ash"
          >
            <Trash2 className="size-4" /> エラーの記録を消す ({errorCount} 件)
          </button>
        )}
      </div>

      {!report ? (
        <p className="text-xs text-ebony-500">まだ点検していません。</p>
      ) : (
        <>
          <p className="mb-2 text-xs text-ebony-500">最後の点検: {new Date(report.checkedAt).toLocaleString("ja-JP")}</p>
          {report.warnings.length === 0 ? (
            <p className="flex items-center gap-1.5 text-sm text-emerald-300">
              <CheckCircle2 className="size-4" /> 確かめてほしいことはありません
            </p>
          ) : (
            <ul className="space-y-2">
              {report.warnings.map((issue, i) => (
                <li key={i} className="rounded-lg border border-amber-500/40 bg-amber-900/15 p-2.5 text-sm">
                  <p className="flex gap-1.5 text-amber-200">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {issue.message}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5 pl-5">
                    {issue.warlordIds
                      .filter((id) => byId.has(id))
                      .map((id) => {
                        const w = byId.get(id)!;
                        return (
                          <button key={id} onClick={() => onOpenWarlord(id)} className="rounded border border-ebony-600 px-2 py-0.5 text-xs text-gold-300">
                            {w.is_special ? "【特】" : ""}
                            {w.name}
                            {w.rarity ? ` ${w.rarity}` : ""} ・画像 {w.screenshot_count} 枚 を開く
                          </button>
                        );
                      })}
                    {(issue.kind === "mixed_art" || issue.kind === "too_many_images") && (
                      <button onClick={() => void split(issue.warlordIds[0])} className="flex items-center gap-1 rounded border border-gold-600/60 px-2 py-0.5 text-xs text-gold-400">
                        <Split className="size-3" /> 立ち絵ごとに分ける
                      </button>
                    )}
                    {issue.kind === "duplicate" && (
                      <button onClick={() => void mergeGroup(issue.warlordIds)} className="flex items-center gap-1 rounded border border-gold-600/60 px-2 py-0.5 text-xs text-gold-400">
                        <Merge className="size-3" /> 1 人にまとめる
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {report.fixed.length > 0 && (
            <details className="mt-3 text-xs text-ash">
              <summary className="cursor-pointer">前回の点検で自動で直したこと ({report.fixed.length} 件)</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {report.fixed.map((issue, i) => (
                  <li key={i}>{issue.message}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
