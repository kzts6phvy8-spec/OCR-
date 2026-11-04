import { Flame } from "lucide-react";
import type { Warlord } from "../../core/types.ts";
import { ONI_SEASONS } from "../../core/seasons.ts";
import { ONI_GROUP_SIZE } from "../../core/health.ts";

// 「データ管理」の鬼のシーズン一覧: シーズン (4 人の組) ごとに、図鑑に登録されている鬼を並べる

export function OniSeasonPanel({ warlords, onOpenWarlord }: { warlords: Warlord[]; onOpenWarlord: (id: string) => void }) {
  const onis = warlords.filter((w) => w.faction === "鬼憑武将");
  if (onis.length === 0) return null;
  const unknown = onis.filter((w) => !w.oni_season);
  return (
    <section className="panel p-5 md:col-span-2">
      <h2 className="mb-1 flex items-center gap-2 font-serif text-lg font-bold text-gold-400">
        <Flame className="size-5" /> 鬼のシーズン
      </h2>
      <p className="mb-3 text-sm text-ash">
        シーズン (4 人の組) ごとに、図鑑に登録されている鬼憑武将です。シーズンは連携スキルの文章から自動で入り、武将の編集でも選べます。
      </p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {ONI_SEASONS.map((season) => {
          const members = [...new Map(onis.filter((w) => w.oni_season === season).map((w) => [w.name, w])).values()];
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
