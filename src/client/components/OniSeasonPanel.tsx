import { useMemo } from "react";
import { Flame } from "lucide-react";
import type { Warlord } from "../../core/types.ts";
import { ONI_SEASONS, detectSeason } from "../../core/seasons.ts";
import { ONI_GROUP_SIZE, resolveOniSeasons } from "../../core/health.ts";

// 「データ管理」の鬼のシーズン一覧: シーズン (4 人の組) ごとに、図鑑に登録されている鬼を並べる

export function OniSeasonPanel({ warlords, onOpenWarlord }: { warlords: Warlord[]; onOpenWarlord: (id: string) => void }) {
  const { onis, wrongFaction, seasonOf, unknown } = useMemo(() => {
    const onis = warlords.filter((w) => w.faction === "鬼憑武将");
    // 「鬼憑 + シーズン名」の連携スキルがあるのに、勢力が鬼憑武将になっていない武将 (勢力の読み違い)
    const wrongFaction = warlords.filter((w) => w.faction !== "鬼憑武将" && detectSeason(w.synergy_skills));
    // 点検と同じ決め方 (選んだシーズン・連携スキルの文章・連携スキルで指し合う鬼から)
    const seasonOf = resolveOniSeasons(onis);
    return { onis, wrongFaction, seasonOf, unknown: onis.filter((w) => !seasonOf.has(w.id)) };
  }, [warlords]);
  if (onis.length === 0 && wrongFaction.length === 0) return null;
  return (
    <section className="panel p-5 md:col-span-2">
      <h2 className="mb-1 flex items-center gap-2 font-serif text-lg font-bold text-gold-400">
        <Flame className="size-5" /> 鬼のシーズン
      </h2>
      <p className="mb-3 text-sm text-ash">
        シーズン (4 人の組) ごとに、図鑑に登録されている鬼憑武将です。シーズンは連携スキルの文章から自動で入り、武将の編集でも選べます。
        「(推定)」は、連携スキルで指し合っている鬼のシーズンから決めたものです。
      </p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {ONI_SEASONS.map((season) => {
          const members = [...new Map(onis.filter((w) => seasonOf.get(w.id) === season).map((w) => [w.name, w])).values()];
          const misfiled = wrongFaction.filter((w) => detectSeason(w.synergy_skills) === season);
          const done = members.length === ONI_GROUP_SIZE;
          return (
            <li key={season} className={`rounded-lg border p-2.5 text-sm ${done ? "border-emerald-700/60" : "border-ebony-700"}`}>
              <div className="flex items-center justify-between">
                <span className="font-bold">{season}</span>
                <span className={`text-xs ${done ? "text-emerald-300" : members.length > ONI_GROUP_SIZE ? "text-hi-400" : "text-ash"}`}>
                  {members.length} / {ONI_GROUP_SIZE} 人
                </span>
              </div>
              {members.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {members.map((w) => (
                    <button key={w.id} onClick={() => onOpenWarlord(w.id)} className="rounded border border-ebony-600 px-1.5 py-0.5 text-xs text-gold-300">
                      {w.is_special ? "【特】" : ""}
                      {w.name}
                      {!w.oni_season && !detectSeason(w.synergy_skills) && <span className="ml-0.5 text-[10px] text-ash">(推定)</span>}
                    </button>
                  ))}
                </div>
              )}
              {misfiled.length > 0 && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px] text-amber-200">
                  勢力が鬼憑武将になっていない:
                  {misfiled.map((w) => (
                    <button key={w.id} onClick={() => onOpenWarlord(w.id)} className="rounded border border-amber-500/50 px-1.5 py-0.5 text-xs">
                      {w.is_special ? "【特】" : ""}
                      {w.name} ({w.faction || "勢力未入力"})
                    </button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {unknown.length > 0 && (
        <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-900/15 p-2.5 text-sm">
          <p className="text-amber-200">シーズンが分からない鬼 ({unknown.length} 人): 武将の編集で「シーズン」を選ぶと、上に入ります</p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {unknown.map((w) => (
              <button key={w.id} onClick={() => onOpenWarlord(w.id)} className="rounded border border-ebony-600 px-1.5 py-0.5 text-xs text-gold-300">
                {w.is_special ? "【特】" : ""}
                {w.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
