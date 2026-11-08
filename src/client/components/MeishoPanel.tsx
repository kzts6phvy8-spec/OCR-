import { useMemo } from "react";
import { Crown } from "lucide-react";
import type { Warlord } from "../../core/types.ts";
import { matchMeishoRoster } from "../../core/meisho.ts";

// 「データ管理」の名将一覧: ゲーム内の「名将一覧」の武将が図鑑のどの武将か、登録されていない名将はいないかを見せる

export function MeishoPanel({ warlords, onOpenWarlord }: { warlords: Warlord[]; onOpenWarlord: (id: string) => void }) {
  const matches = useMemo(() => matchMeishoRoster(warlords), [warlords]);
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
