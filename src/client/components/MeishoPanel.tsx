import { useMemo, useState } from "react";
import { Crown, Download, Sparkles } from "lucide-react";
import { api } from "../lib/api.ts";
import { useToast } from "../lib/toast.tsx";
import { saveFile, today } from "../lib/share.ts";
import type { Warlord } from "../../core/types.ts";
import { matchMeishoRoster } from "../../core/meisho.ts";

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
  const ambiguous = matches.filter((m) => m.candidates.length > 0 && m.decided.length === 0).flatMap((m) => m.candidates);
  const meishoCount = warlords.filter((w) => w.is_meisho).length;

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

  const save = async (format: "txt" | "json") => {
    try {
      const r = await api.exportMeisho(format);
      if (r.count === 0) return toast("info", "名将の印が付いた武将がいません");
      await saveFile(r.blob, `名将-${today()}.${format}`, "戦国布武 名将の武将");
    } catch (e) {
      toast("error", "保存できませんでした", (e as Error).message);
    }
  };
  const factions = [...new Set(matches.map((m) => m.faction))];
  const missing = matches.filter((m) => m.candidates.length === 0).length;
  const choose = matches.filter((m) => m.candidates.length > 0 && m.decided.length === 0).length;
  return (
    <section className="panel p-5 md:col-span-2">
      <h2 className="mb-1 flex items-center gap-2 font-serif text-lg font-bold text-gold-400">
        <Crown className="size-5" /> 名将一覧
      </h2>
      <p className="mb-3 text-sm text-ash">
        ゲーム内の「名将一覧」に並ぶ武将です。勢力と名前が合う武将には、自動で「名将」の印を付けています。
        {choose > 0 && ` 同じ勢力に同じ名前の武将が何人もいる ${choose} 件は、立ち絵を見て名将の方を開き、編集で「名将」にチェックを入れてください。`}
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
        <button onClick={() => void save("json")} className="inline-flex items-center gap-1.5 rounded-lg border border-ebony-600 px-3 py-1.5 text-sm text-washi">
          <Download className="size-4" /> 名将だけ保存 (.json)
        </button>
      </div>
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
                  if (m.decided.length === 0) {
                    return (
                      <li key={m.name + (m.group ?? "")} className="flex flex-wrap items-center gap-1 rounded border border-hi-600/60 px-2 py-0.5 text-xs text-hi-400">
                        {label}: どれか選んでください
                        {m.candidates.map((w) => (
                          <button key={w.id} onClick={() => onOpenWarlord(w.id)} className="rounded bg-ebony-800 px-1.5 text-washi">
                            {w.is_special ? "【特】" : ""}
                            {w.name}
                            {w.title_alias && `(${w.title_alias})`}
                            {w.is_meisho && " ✓"}
                          </button>
                        ))}
                      </li>
                    );
                  }
                  return m.decided.map((w) => (
                    <li key={w.id}>
                      <button onClick={() => onOpenWarlord(w.id)} className="rounded border border-shu-500/60 px-2 py-0.5 text-xs text-washi" title={m.group}>
                        {w.is_special ? "【特】" : ""}
                        {w.name}
                        {w.is_meisho ? " ✓" : ""}
                      </button>
                    </li>
                  ));
                })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
