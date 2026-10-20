import { useMemo, useState } from "react";
import { Images, LayoutGrid, List, Plus, ScanLine, Search, SlidersHorizontal, UserRound } from "lucide-react";
import { FACTIONS, RARITIES, type Warlord } from "../../core/types.ts";
import { RarityBadge, SpecialBadge, Stars, WeaponBadge } from "./Badges.tsx";
import { StoredImage } from "./StoredImage.tsx";

type SpecialFilter = "all" | "normal" | "special";
type SortKey = "growth" | "created" | "name" | "faction";

const SORTS: { id: SortKey; label: string }[] = [
  { id: "growth", label: "成長値合計順" },
  { id: "created", label: "登録日順" },
  { id: "name", label: "名前順" },
  { id: "faction", label: "勢力順" },
];

function searchText(w: Warlord): string {
  return [
    w.name,
    w.title_alias,
    w.skill_name,
    w.skill_desc,
    w.awakening_skill_name,
    w.awakening_before_weapon,
    w.awakening_after_weapon,
    w.troop_type,
    ...w.troop_variants,
    ...w.talents.flatMap((t) => [t.name, t.effect]),
    ...w.synergy_skills.flatMap((s) => [s.partner, s.effect]),
  ]
    .join("\n")
    .normalize("NFKC")
    .toLowerCase();
}

interface Props {
  warlords: Warlord[];
  loading: boolean;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onGoUpload: () => void;
}

export function WarlordGrid({ warlords, loading, onOpen, onCreate, onGoUpload }: Props) {
  const [faction, setFaction] = useState<string>("all");
  const [rarities, setRarities] = useState<string[]>([]);
  const [special, setSpecial] = useState<SpecialFilter>("all");
  const [weaponOnly, setWeaponOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("growth");
  const [layout, setLayoutState] = useState<"grid" | "list">(() => {
    try {
      return localStorage.getItem("zukan-layout") === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  });
  const setLayout = (v: "grid" | "list") => {
    setLayoutState(v);
    try {
      localStorage.setItem("zukan-layout", v);
    } catch {
      /* 保存できなくても表示は切り替わる */
    }
  };

  const indexed = useMemo(() => warlords.map((w) => ({ w, text: searchText(w) })), [warlords]);

  const visible = useMemo(() => {
    const terms = query.normalize("NFKC").toLowerCase().split(/\s+/).filter(Boolean);
    const list = indexed
      .filter(({ w, text }) => {
        if (faction !== "all" && w.faction !== faction) return false;
        if (rarities.length && !rarities.includes(w.rarity)) return false;
        if (special === "normal" && w.is_special) return false;
        if (special === "special" && !w.is_special) return false;
        if (weaponOnly && !w.has_weapon_awakening) return false;
        return terms.every((t) => text.includes(t));
      })
      .map(({ w }) => w);

    const byName = (a: Warlord, b: Warlord) => a.name.localeCompare(b.name, "ja") || Number(a.is_special) - Number(b.is_special);
    const factionIdx = (w: Warlord) => (w.faction ? FACTIONS.indexOf(w.faction) : 99);
    return list.sort((a, b) => {
      switch (sort) {
        case "growth":
          return (parseFloat(b.growth_total) || 0) - (parseFloat(a.growth_total) || 0) || byName(a, b);
        case "created":
          return b.created_at.localeCompare(a.created_at);
        case "name":
          return byName(a, b);
        case "faction":
          return factionIdx(a) - factionIdx(b) || byName(a, b);
      }
    });
  }, [indexed, faction, rarities, special, weaponOnly, query, sort]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const w of warlords) map.set(w.faction, (map.get(w.faction) ?? 0) + 1);
    return map;
  }, [warlords]);

  const toggleRarity = (r: string) => setRarities((cur) => (cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]));

  return (
    <div>
      {/* 勢力タブ */}
      <div className="scroll-thin -mx-4 mb-4 flex gap-1 overflow-x-auto px-4 pb-1">
        {[{ id: "all", label: "全勢力", n: warlords.length }, ...FACTIONS.map((f) => ({ id: f, label: f, n: counts.get(f) ?? 0 }))].map(
          (f) => (
            <button
              key={f.id}
              onClick={() => setFaction(f.id)}
              className={`shrink-0 rounded-t-md border-b-2 px-3 py-2 font-serif text-sm font-bold whitespace-nowrap transition ${
                faction === f.id ? "border-gold-500 text-gold-300" : "border-transparent text-ash hover:text-washi"
              }`}
            >
              {f.label}
              <span className="ml-1 text-[10px] font-normal text-ebony-500">{f.n}</span>
            </button>
          ),
        )}
      </div>

      {/* 絞り込み */}
      <div className="panel mb-5 flex flex-wrap items-center gap-3 p-3">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ebony-500" />
          <input
            className="field pl-9"
            placeholder="武将名・スキル名・効果名で検索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-1">
          {RARITIES.map((r) => (
            <button
              key={r}
              onClick={() => toggleRarity(r)}
              className={`rounded-md border px-2 py-1 text-xs font-bold transition ${
                rarities.includes(r) ? "border-gold-500 bg-gold-500/15 text-gold-300" : "border-ebony-600 text-ash hover:text-washi"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
        <div className="flex rounded-md border border-ebony-600 p-0.5 text-xs">
          {(
            [
              ["all", "すべて"],
              ["normal", "通常"],
              ["special", "特異"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setSpecial(id)}
              className={`rounded px-2.5 py-1 font-bold transition ${special === id ? "bg-gold-500 text-ebony-950" : "text-ash hover:text-washi"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ash">
          <input type="checkbox" checked={weaponOnly} onChange={(e) => setWeaponOnly(e.target.checked)} className="accent-hi-500" />
          武器覚醒のみ
        </label>
        <div className="flex items-center gap-1.5">
          <SlidersHorizontal className="size-4 text-ebony-500" />
          <select className="field w-auto py-1 text-xs" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex rounded-lg border border-ebony-600 p-0.5">
          {(
            [
              ["grid", LayoutGrid, "カード表示"],
              ["list", List, "リスト表示"],
            ] as const
          ).map(([id, Icon, label]) => (
            <button
              key={id}
              onClick={() => setLayout(id)}
              aria-label={label}
              title={label}
              className={`rounded-md px-2.5 py-1 ${layout === id ? "bg-shu-500 text-white" : "text-ash"}`}
            >
              <Icon className="size-4" />
            </button>
          ))}
        </div>
        <button
          onClick={onCreate}
          className="ml-auto flex items-center gap-1 rounded-md border border-gold-600/60 px-3 py-1.5 text-xs font-bold text-gold-400 hover:bg-gold-500/10"
        >
          <Plus className="size-3.5" /> 手動登録
        </button>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="panel aspect-[3/4] animate-pulse" />
          ))}
        </div>
      ) : warlords.length === 0 ? (
        <div className="panel flex flex-col items-center gap-3 py-16 text-center">
          <UserRound className="size-12 text-ebony-600" />
          <p className="font-serif text-lg text-washi">まだ武将が登録されていません</p>
          <p className="text-sm text-ash">ゲーム画面のスクリーンショットをアップロードすると、AI が自動で図鑑に登録します。</p>
          <button
            onClick={onGoUpload}
            className="mt-2 flex items-center gap-2 rounded-lg bg-gradient-to-b from-hi-500 to-hi-600 px-5 py-2 font-bold text-white"
          >
            <ScanLine className="size-4" /> スクショを解析する
          </button>
        </div>
      ) : visible.length === 0 ? (
        <p className="py-16 text-center text-sm text-ash">条件に一致する武将がいません</p>
      ) : (
        <>
          <p className="mb-3 text-xs text-ash">{visible.length} 件</p>
          {layout === "grid" ? (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {visible.map((w) => (
                <WarlordCard key={w.id} w={w} onClick={() => onOpen(w.id)} />
              ))}
            </div>
          ) : (
            <ul className="space-y-2">
              {visible.map((w) => (
                <li key={w.id}>
                  <WarlordRow w={w} onClick={() => onOpen(w.id)} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function WarlordCard({ w, onClick }: { w: Warlord; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`group relative flex flex-col overflow-hidden rounded-xl border text-left transition hover:-translate-y-0.5 hover:shadow-2xl ${
        w.is_special
          ? "border-gold-500/70 shadow-[0_0_0_1px_rgb(201_162_74/0.25),0_10px_30px_-12px_rgb(201_162_74/0.35)]"
          : "border-ebony-700 hover:border-ebony-500"
      } bg-ebony-900`}
    >
      <div className="relative aspect-[4/5] overflow-hidden bg-ebony-800">
        {w.image_url ? (
          <StoredImage id={w.image_url} alt={w.name} className="size-full object-cover object-top transition duration-500 group-hover:scale-105" />
        ) : (
          <div className="grid size-full place-items-center font-serif text-5xl text-ebony-600">{w.name.slice(0, 1)}</div>
        )}
        <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-ebony-950 via-ebony-950/70 to-transparent" />
        <div className="absolute top-2 left-2 flex items-center gap-1">
          <RarityBadge rarity={w.rarity} />
          {w.is_special && <SpecialBadge />}
        </div>
        {w.screenshot_count > 0 && (
          <span className="absolute top-2 right-2 flex items-center gap-0.5 rounded bg-ebony-950/80 px-1.5 py-0.5 text-[10px] text-ash">
            <Images className="size-3" /> {w.screenshot_count}
          </span>
        )}
        <div className="absolute inset-x-0 bottom-0 p-3">
          {w.title_alias && <p className="truncate text-[11px] text-gold-400/90">{w.title_alias}</p>}
          <p className="truncate font-serif text-lg font-extrabold">{w.name}</p>
          <div className="mt-0.5 flex items-center justify-between gap-1">
            <Stars count={w.stars} className="text-xs" />
            {w.growth_total && (
              <span className="text-xs text-ash">
                成長 <span className="font-bold text-gold-300">{w.growth_total}</span>
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="flex min-h-10 flex-wrap items-center gap-1 border-t border-ebony-800 px-3 py-2 text-[11px] text-ash">
        {w.faction && <span className="rounded bg-ebony-800 px-1.5 py-0.5">{w.faction}</span>}
        {w.skill_name && <span className="truncate">『{w.skill_name}』</span>}
        {w.has_weapon_awakening && <WeaponBadge />}
      </div>
    </button>
  );
}

function WarlordRow({ w, onClick }: { w: Warlord; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-xl border bg-ebony-900 p-2 text-left transition hover:border-ebony-500 ${
        w.is_special ? "border-gold-500/60" : "border-ebony-700"
      }`}
    >
      <div className="h-16 w-12 shrink-0 overflow-hidden rounded-md bg-ebony-800">
        {w.image_url && <StoredImage id={w.image_url} alt="" className="size-full object-cover object-top" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <RarityBadge rarity={w.rarity} />
          {w.is_special && <SpecialBadge />}
          <span className="truncate font-serif text-base font-extrabold">{w.name}</span>
          {w.faction && <span className="shrink-0 rounded bg-ebony-800 px-1.5 py-0.5 text-[10px] text-ash">{w.faction}</span>}
        </div>
        <p className="mt-0.5 truncate text-xs text-ash">
          {w.skill_name && `『${w.skill_name}』`}
          {w.awakening_skill_name && ` 覚醒『${w.awakening_skill_name}』`}
        </p>
      </div>
      <div className="shrink-0 text-right">
        {w.growth_total && (
          <p className="text-xs text-ash">
            成長 <span className="text-base font-bold text-shu-300">{w.growth_total}</span>
          </p>
        )}
        <div className="mt-0.5 flex items-center justify-end gap-1">
          {w.has_weapon_awakening && <WeaponBadge />}
          <span className="flex items-center gap-0.5 text-[10px] text-ash">
            <Images className="size-3" /> {w.screenshot_count}
          </span>
        </div>
      </div>
    </button>
  );
}
