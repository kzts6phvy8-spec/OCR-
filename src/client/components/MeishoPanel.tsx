import { useMemo, useState } from "react";
import { Crown, Download, Sparkles } from "lucide-react";
import { api } from "../lib/api.ts";
import { useToast } from "../lib/toast.tsx";
import { saveFile, today } from "../lib/share.ts";
import type { Warlord } from "../../core/types.ts";
import { matchMeishoRoster } from "../../core/meisho.ts";
import { meishoTalentGaps } from "../../core/missing.ts";
import { StoredImage } from "./StoredImage.tsx";

// 「データ管理」の名将一覧: ゲーム内の「名将一覧」の武将が図鑑のどの武将か、登録されていない名将はいないかを見せる

export function MeishoPanel({
  warlords,
  onOpenWarlord,
  onChanged,
}: {
  warlords: Warlord[];
  onOpenWarlord: (id: string) => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [progress, setProgress] = useState<string | null>(null);
  const matches = useMemo(() => matchMeishoRoster(warlords), [warlords]);
  const ambiguous = matches
    .filter((m) => m.candidates.length > 0 && m.decided.length === 0 && !m.candidates.some((w) => w.meisho_manual))
    .flatMap((m) => m.candidates);
  const meishoCount = warlords.filter((w) => w.is_meisho).length;
  // 名将修行の追加天賦 (丸 8 つ) がそろっているか
  const gaps = warlords
    .filter((w) => w.is_meisho)
    .map((w) => ({ w, gaps: meishoTalentGaps(w) }))
    .filter((g) => g.gaps.length > 0)
    .sort((a, b) => a.w.faction.localeCompare(b.w.faction, "ja") || a.w.name.localeCompare(b.w.name, "ja"));

  const checkWithAi = async () => {
    if (!confirm(`同じ名前の武将がいて名将か決められない ${ambiguous.length} 人を、AI に登録画像を見せて見分けますか？\nAI に最大 ${ambiguous.length} 回問い合わせます。この iPhone で調べるので、終わるまでアプリを開いたままにしてください。`)) return;
    try {
      const r = await api.checkAmbiguousMeisho((done, total, name) => setProgress(`${done} / ${total}${name ? ` ${name}` : ""}`));
      const notes = [
        r.notMeisho && `名将ではない ${r.notMeisho} 人`,
        r.unknown.length && `スキル画面のスクショが無く分からない ${r.unknown.length} 人 (${r.unknown.join("、")})`,
        r.stopped && `途中で止まりました: ${r.stopped}`,
      ].filter(Boolean);
      toast(r.stopped ? "warning" : "success", `${r.marked} 人を名将と見分けました`, notes.join(" / ") || undefined);
      onChanged();
    } catch (e) {
      toast("error", "見分けられませんでした", (e as Error).message);
    } finally {
      setProgress(null);
    }
  };

  const toggle = async (w: Warlord) => {
    try {
      await api.setMeisho(w.id, !w.is_meisho);
      onChanged();
    } catch (e) {
      toast("error", "変更できませんでした", (e as Error).message);
    }
  };

  const save = async (format: "txt" | "json" | "training") => {
    try {
      const r = await api.exportMeisho(format);
      if (r.count === 0) return toast("info", "名将の印が付いた武将がいません");
      await saveFile(r.blob, format === "training" ? `名将修行-${today()}.txt` : `名将-${today()}.${format}`, "戦国布武 名将の武将");
    } catch (e) {
      toast("error", "保存できませんでした", (e as Error).message);
    }
  };
  const factions = [...new Set(matches.map((m) => m.faction))];
  const missing = matches.filter((m) => m.candidates.length === 0).length;
  const choose = matches.filter((m) => m.candidates.length > 0 && m.decided.length === 0 && !m.candidates.some((w) => w.meisho_manual)).length;
  return (
    <section className="panel p-5 md:col-span-2">
      <h2 className="mb-1 flex items-center gap-2 font-serif text-lg font-bold text-gold-400">
        <Crown className="size-5" /> 名将一覧
      </h2>
      <p className="mb-3 text-sm text-ash">
        ゲーム内の「名将一覧」に並ぶ武将です。勢力と名前が合う武将には、自動で「名将」の印を付けています。
        {" 立ち絵の横のボタンで、手で名将を付け外しできます (手で決めた武将は、自動の判断で変わりません)。"}
        {choose > 0 && ` 同じ勢力に同じ名前の武将が何人もいる ${choose} 件は、立ち絵を見て名将の方を選ぶか、AI で見分けてください。`}
        {missing > 0 && ` まだ図鑑に登録されていない名将が ${missing} 人います。`}
      </p>
      <div className="mb-4 flex flex-wrap gap-2">
        {ambiguous.length > 0 && (
          <button
            onClick={() => void checkWithAi()}
            disabled={progress !== null}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gold-600/60 px-3 py-1.5 text-sm text-gold-300 disabled:opacity-50"
          >
            <Sparkles className="size-4" /> {progress ? `見分けています… ${progress}` : `同じ名前の ${ambiguous.length} 人を AI で見分ける`}
          </button>
        )}
        <button onClick={() => void save("txt")} className="inline-flex items-center gap-1.5 rounded-lg border border-ebony-600 px-3 py-1.5 text-sm text-washi">
          <Download className="size-4" /> 名将だけ保存 (.txt・{meishoCount} 人)
        </button>
        <button
          onClick={() =>
            void (async () => {
              if (
                !confirm(
                  "名将修行の画面を、保存してある画像から見分け直しますか？\n全員の名将修行の追加天賦をいったん空にして、画像ごとに誰の画面かを決め直します (文字の読み取りはやり直しません)。\n同じ武将の 2 枚目からは、1 枚目と見比べるだけなので AI を使いません (1 人につき AI 2 回ほど)。",
                )
              )
                return;
              const n = await api.reidentifyMeishoTraining();
              if (n === 0) toast("info", "保存してある名将修行の画面がありません", "名将修行のスクショを取り込み直してください");
              else toast("info", `${n} 枚の名将修行の画面を見分け直します`, "進み具合は「スクショ解析」タブで見られます");
              onChanged();
            })()
          }
          className="inline-flex items-center gap-1.5 rounded-lg border border-hi-600/60 px-3 py-1.5 text-sm text-hi-400"
        >
          <Sparkles className="size-4" /> 名将修行を見分け直す (保存済みの画像から)
        </button>
        <button onClick={() => void save("training")} className="inline-flex items-center gap-1.5 rounded-lg border border-shu-500/60 px-3 py-1.5 text-sm text-washi">
          <Download className="size-4" /> 名将修行の追加天賦だけ保存 (.txt)
        </button>
        <button onClick={() => void save("json")} className="inline-flex items-center gap-1.5 rounded-lg border border-ebony-600 px-3 py-1.5 text-sm text-washi">
          <Download className="size-4" /> 名将だけ保存 (.json)
        </button>
      </div>
      {(() => {
        // 1 つも無い名将は、シミュレーターの方に直接渡してあるので問題にしない。途中まで入っていて足りない名将だけ知らせる
        const partial = gaps.filter((g) => g.gaps.length < 8);
        const none = gaps.length - partial.length;
        return (
          <div className={`mb-4 rounded-lg border p-3 text-xs ${partial.length ? "border-hi-600/60" : "border-emerald-700/60"}`}>
            <p className={`font-bold ${partial.length ? "text-hi-400" : "text-emerald-300"}`}>
              名将修行の追加天賦: 8 つそろっている {meishoCount - gaps.length} 人 / 途中まで {partial.length} 人 / 図鑑には無し {none} 人
            </p>
            {none > 0 && <p className="mt-0.5 text-ash">「図鑑には無し」の名将は、シミュレーターの方に直接渡してあります。</p>}
            {partial.length > 0 && (
              <ul className="mt-1.5 space-y-1">
                {partial.map(({ w, gaps: g }) => (
                  <li key={w.id}>
                    <button onClick={() => onOpenWarlord(w.id)} className="text-left text-washi underline-offset-2 hover:underline">
                      {w.is_special ? "【特】" : ""}
                      {w.name}
                      <span className="text-ash">（{w.faction || "勢力未入力"}）</span>
                    </button>
                    <span className="ml-1 text-ash">足りない: {g.join("、")}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })()}
      <div className="space-y-3">
        {factions.map((f) => (
          <div key={f}>
            <p className="mb-1 text-xs font-bold text-gold-300">{f}</p>
            <ul className="flex flex-wrap gap-1.5">
              {matches
                .filter((m) => m.faction === f)
                .map((m) => {
                  const label = `${m.name}${m.count > 1 ? ` ×${m.count}` : ""}`;
                  if (m.candidates.length === 0) {
                    return (
                      <li key={m.name + (m.group ?? "")} className="rounded border border-dashed border-ebony-600 px-2 py-0.5 text-xs text-ebony-500" title="図鑑に未登録">
                        {label} (未登録)
                      </li>
                    );
                  }
                  const unsure = m.decided.length === 0 && !m.candidates.some((w) => w.meisho_manual);
                  return (
                    <li
                      key={m.name + (m.group ?? "")}
                      className={`rounded-lg border p-1.5 text-xs ${unsure ? "border-hi-600/60" : "border-ebony-700"}`}
                      title={m.group}
                    >
                      {unsure && <p className="mb-1 text-hi-400">{label}: 名将の方を選んでください</p>}
                      <div className="flex flex-wrap gap-1.5">
                        {m.candidates.map((w) => (
                          <MeishoChoice key={w.id} w={w} onOpen={() => onOpenWarlord(w.id)} onToggle={() => void toggle(w)} />
                        ))}
                      </div>
                    </li>
                  );
                })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

/** 名将の候補 1 人: 立ち絵 (押すと武将を開く) と、名将の付け外しボタン */
function MeishoChoice({ w, onOpen, onToggle }: { w: Warlord; onOpen: () => void; onToggle: () => void }) {
  return (
    <div className={`flex items-center gap-1.5 rounded border px-1 py-1 ${w.is_meisho ? "border-shu-500/70 bg-shu-700/20" : "border-ebony-700"}`}>
      <button onClick={onOpen} className="flex items-center gap-1.5 text-left" aria-label={`${w.name} を開く`}>
        {w.image_url ? (
          <StoredImage id={w.image_url} alt="" className="h-12 w-9 shrink-0 rounded object-cover object-left" />
        ) : (
          <span className="grid h-12 w-9 place-items-center rounded bg-ebony-800 font-serif text-ebony-500">{w.name.slice(0, 1)}</span>
        )}
        <span className="max-w-24 truncate text-washi">
          {w.is_special ? "【特】" : ""}
          {w.name}
          {w.title_alias && <span className="block truncate text-[10px] text-ash">{w.title_alias}</span>}
        </span>
      </button>
      <button
        onClick={onToggle}
        className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${w.is_meisho ? "bg-shu-600 text-white" : "border border-ebony-600 text-ash"}`}
      >
        {w.is_meisho ? "名将 ✓" : "名将にする"}
      </button>
    </div>
  );
}
