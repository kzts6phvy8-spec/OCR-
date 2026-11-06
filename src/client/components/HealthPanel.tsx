import { useState } from "react";
import { CheckCircle2, ClipboardCopy, Images, Loader2, RotateCcw, ShieldCheck, Split, Trash2, TriangleAlert } from "lucide-react";
import { api, lastHealthReport, type HealthReport } from "../lib/api.ts";
import { clearErrorLog, getErrorLog } from "../lib/errorLog.ts";
import { useToast } from "../lib/toast.tsx";
import type { Warlord } from "../../core/types.ts";
import type { CrossDuplicate } from "../lib/dedupe.ts";
import { StoredImage } from "./StoredImage.tsx";

// 「データ管理」の自動点検: 起動のたびに、画像が 7 枚以上・1 枚だけの武将を知らせる。
// 点検結果とエラーの記録をコピーして送れるようにする。

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

  // 同じ画像なのに別々の武将に登録されているもの (押した時だけ調べる。全部の画像を読むので少し時間がかかる)
  const [dups, setDups] = useState<CrossDuplicate[] | null>(null);
  const [scan, setScan] = useState<{ done: number; total: number } | null>(null);
  const findDups = async () => {
    setScan({ done: 0, total: 0 });
    try {
      const { findCrossDuplicates } = await import("../lib/dedupe.ts");
      setDups(await findCrossDuplicates((done, total) => setScan({ done, total })));
    } catch (e) {
      toast("error", "調べられませんでした", (e as Error).message);
    } finally {
      setScan(null);
    }
  };
  const removeFrom = async (warlordId: string, imageId: string) => {
    const w = byId.get(warlordId);
    if (!w || !confirm(`この画像を「${w.is_special ? "【特】" : ""}${w.name}」から外しますか？\n(ほかの武将に入っている同じ画像は残ります)`)) return;
    try {
      await api.updateWarlord(warlordId, {}, { removeImages: [imageId] });
      setDups((cur) => cur?.map((d) => ({ ...d, entries: d.entries.filter((e) => !(e.warlordId === warlordId && e.imageId === imageId)) })).filter((d) => d.entries.length > 1) ?? null);
      toast("success", "画像を外しました");
      onChanged();
    } catch (e) {
      toast("error", "外せませんでした", (e as Error).message);
    }
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
        アプリを開くたびに、統合した画像が 7 枚以上の武将 (別の武将の画像が混ざっている)、画像が 1 枚だけの武将、
        鬼の組 (同じシーズンの 4 人) でまだ図鑑に登録されていない鬼がいる時に知らせます。
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
                    {issue.kind === "too_many_images" && (
                      <button onClick={() => void split(issue.warlordIds[0])} className="flex items-center gap-1 rounded border border-gold-600/60 px-2 py-0.5 text-xs text-gold-400">
                        <Split className="size-3" /> 立ち絵ごとに分ける
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
      <div className="mt-4 border-t border-ebony-700 pt-3">
        <TalentRules />
        <button
          onClick={async () => {
            const t = await api.talentRereadTargets();
            const n = t.undecided.length + t.conflicting.length;
            if (n === 0) {
              toast("info", "天賦の法則に当てはまらない武将はいません");
              return;
            }
            if (
              !confirm(
                `天賦の法則に当てはまらない ${n} 人の天賦を読み直しますか？\n・法則で並びを決められなかった武将: ${t.undecided.length} 人\n・法則とはっきり食い違う武将: ${t.conflicting.length} 人\n法則に当てはまる武将は読み直しません。\n登録画像から天賦の画面を探し、画面の位置で星1〜星5 を決め直して置き換えます。\nAI に最大 ${n} 回問い合わせます (Flash-Lite の無料枠なら 1 日 約 500 回)。この iPhone で解析するので、終わるまでアプリを開いたままにしてください。`,
              )
            )
              return;
            const count = await api.rereadTalents();
            toast("info", `${count} 人の天賦を読み直します`, "進み具合は「スクショ解析」タブで見られます");
          }}
          className="mb-2 flex items-center gap-1.5 rounded-lg border border-gold-600/60 px-3 py-1.5 text-sm text-gold-400"
        >
          <RotateCcw className="size-4" /> 天賦の法則に当てはまらない武将だけ読み直す (AI)
        </button>
        <button
          onClick={() => void findDups()}
          disabled={scan !== null}
          className="flex items-center gap-1.5 rounded-lg border border-ebony-600 px-3 py-1.5 text-sm text-ash disabled:opacity-40"
        >
          {scan ? <Loader2 className="size-4 animate-spin" /> : <Images className="size-4" />}
          {scan ? `調べています (${scan.done} / ${scan.total || "…"} 枚)` : "同じ画像なのに別の武将に登録されているものを探す"}
        </button>
        {dups && dups.length === 0 && <p className="mt-2 text-sm text-emerald-300">見つかりませんでした</p>}
        {dups && dups.length > 0 && (
          <ul className="mt-2 space-y-2">
            {dups.map((d, i) => (
              <li key={i} className="rounded-lg border border-amber-500/40 bg-amber-900/15 p-2.5 text-sm">
                <p className="text-amber-200">
                  {d.kind === "exact" ? "まったく同じ画像が、別々の武将に入っています" : "ほぼ同じ画像 (同じ画面のスクショ) が、同じ名前の別々の武将に入っています"}
                </p>
                <div className="mt-2 grid gap-2">
                  {d.entries.map((e) => {
                    const w = byId.get(e.warlordId);
                    if (!w) return null;
                    return (
                      <div key={`${e.warlordId}-${e.imageId}`} className="flex items-center gap-2">
                        <StoredImage id={e.imageId} alt="" className="h-14 w-11 shrink-0 rounded border border-ebony-700 object-cover object-left" />
                        <button onClick={() => onOpenWarlord(w.id)} className="min-w-0 flex-1 truncate text-left text-gold-300">
                          {w.is_special ? "【特】" : ""}
                          {w.name}
                          <span className="ml-1 text-[11px] text-ash">
                            {[w.rarity, w.faction].filter(Boolean).join(" ・")} ・画像 {w.screenshot_count} 枚
                          </span>
                        </button>
                        <button onClick={() => void removeFrom(w.id, e.imageId)} className="shrink-0 rounded border border-hi-600/60 px-2 py-0.5 text-xs text-hi-400">
                          ここから外す
                        </button>
                      </div>
                    );
                  })}
                </div>
                <p className="mt-1.5 text-[11px] text-ash">同じ武将が 2 人に分かれているなら、武将の画面の「別の武将に分かれた時: まとめる」でまとめられます</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** 並びが確かな武将のデータから見つけた天賦の法則を見せる (この法則で、並びがずれた武将を AI なしで直している) */
function TalentRules() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.talentRules>> | null>(null);
  return (
    <details
      className="mb-3 text-xs text-ash"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open && !data) void api.talentRules().then(setData);
      }}
    >
      <summary className="cursor-pointer text-sm text-gold-300">データから見つけた天賦の法則</summary>
      {!data ? (
        <p className="mt-1">調べています…</p>
      ) : data.rules.length === 0 ? (
        <p className="mt-1">まだはっきりした法則は見つかっていません (並びが確かな武将 {data.from} 人)</p>
      ) : (
        <>
          <p className="mt-1">並びが確かな武将 {data.from} 人の天賦から見つけた法則です。この法則で、並びがずれた武将を AI なしで直しています。</p>
          <ul className="mt-1 space-y-0.5 pl-1">
            {data.rules.map((r) => (
              <li key={r.kind}>
                <span className="text-gold-300">星{r.star}</span> {r.kind}{" "}
                <span className="text-ebony-500">
                  ({Math.round(r.share * 100)}% ・{r.count} 件)
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}
