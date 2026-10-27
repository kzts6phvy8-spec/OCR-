import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import type { Warlord } from "../../core/types.ts";

// 武将を名前・二つ名・勢力で検索して 1 人選ぶ (統合先の指定・武将をまとめる時に使う)

const label = (w: Warlord) => `${w.is_special ? "【特】" : ""}${w.name}`;
const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s/g, "");
const MAX_RESULTS = 50;

export function WarlordPicker({
  warlords,
  value,
  onChange,
  placeholder = "武将名で検索",
  emptyLabel,
  priority,
  suggest,
}: {
  warlords: Warlord[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  /** 未選択の時に表示する説明 (例: 「自動 (読み取った武将名で統合)」) */
  emptyLabel?: string;
  /** 先頭に並べる武将 (同じ名前など)。数字が小さいほど先 */
  priority?: (w: Warlord) => number;
  /** 検索語が空の時に候補として出す武将 (同じ名前など) */
  suggest?: (w: Warlord) => boolean;
}) {
  const [query, setQuery] = useState("");
  const selected = warlords.find((w) => w.id === value) ?? null;

  const results = useMemo(() => {
    const terms = norm(query) ? query.normalize("NFKC").toLowerCase().split(/\s+/).filter(Boolean) : [];
    return warlords
      .filter((w) => {
        if (terms.length === 0) return suggest ? suggest(w) : false;
        const text = norm(`${w.name} ${w.title_alias} ${w.faction} ${w.rarity} ${w.is_special ? "特異 特" : "通常"}`);
        return terms.every((t) => text.includes(norm(t)));
      })
      .sort((a, b) => (priority?.(a) ?? 0) - (priority?.(b) ?? 0) || a.name.localeCompare(b.name, "ja"));
  }, [warlords, query, priority, suggest]);

  if (selected) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-gold-600/60 bg-gold-500/10 px-3 py-2 text-sm">
        <span className="min-w-0 flex-1 truncate font-bold text-gold-300">
          {label(selected)}
          {selected.title_alias && <span className="ml-1 font-normal text-ash">({selected.title_alias})</span>}
          {(selected.rarity || selected.faction) && (
            <span className="ml-1.5 text-xs font-normal text-ash">{[selected.rarity, selected.faction].filter(Boolean).join(" ・")}</span>
          )}
        </span>
        <button onClick={() => onChange("")} className="flex items-center gap-0.5 text-xs text-ash hover:text-washi" aria-label="選び直す">
          <X className="size-4" /> 選び直す
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ebony-500" />
        <input className="field pl-9" placeholder={placeholder} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {emptyLabel && <p className="mt-1 text-[11px] text-ebony-500">未選択: {emptyLabel}</p>}
      {(query.trim() || results.length > 0) && (
        <ul className="scroll-thin mt-1.5 max-h-60 overflow-y-auto rounded-lg border border-ebony-700 bg-ebony-900">
          {results.length === 0 && <li className="px-3 py-2 text-xs text-ash">見つかりません</li>}
          {results.slice(0, MAX_RESULTS).map((w) => (
            <li key={w.id}>
              <button
                onClick={() => {
                  onChange(w.id);
                  setQuery("");
                }}
                className="flex w-full items-center gap-2 border-b border-ebony-800 px-3 py-2 text-left text-sm last:border-0 hover:bg-ebony-800"
              >
                <span className="min-w-0 flex-1 truncate">
                  {label(w)}
                  {w.title_alias && <span className="ml-1 text-xs text-ash">({w.title_alias})</span>}
                </span>
                <span className="shrink-0 text-[11px] text-ash">
                  {w.rarity && `${w.rarity} ・`}
                  {w.faction || "勢力未入力"} ・画像 {w.screenshot_count} 枚
                </span>
              </button>
            </li>
          ))}
          {results.length > MAX_RESULTS && (
            <li className="px-3 py-2 text-[11px] text-ash">ほか {results.length - MAX_RESULTS} 人。もう少し詳しく入力してください</li>
          )}
        </ul>
      )}
    </div>
  );
}
