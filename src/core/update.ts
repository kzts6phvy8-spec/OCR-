// ゲームのアップデート (2 か月に 1 回ほど) で変わった所だけをまとめる。
// アップデートの取り込みを始める時に今の図鑑を「基準」として覚えておき、スクショを取り込んだ後に基準と比べる。

import { detectSeason } from "./seasons.ts";
import type { Warlord } from "./types.ts";

/** 基準として覚えておく、武将 1 人分の要点 */
export interface BaselineEntry {
  name: string;
  title_alias: string;
  faction: string;
  is_special: boolean;
  is_meisho: boolean;
  oni_season: string;
  /** 専用武器覚醒があるか (前の版の基準には無い) */
  has_weapon_awakening?: boolean;
}

export interface UpdateBaseline {
  /** 取り込みを始めた時刻 */
  started_at: string;
  /** 利用者が付けた名前 (例: 2026年12月アップデート) */
  label: string;
  warlords: Record<string, BaselineEntry>;
}

/** 鬼憑武将のシーズン (手で選んだもの、無ければ連携スキルの文章から) */
export const effectiveSeason = (w: Pick<Warlord, "faction" | "oni_season" | "synergy_skills">) =>
  w.faction === "鬼憑武将" ? w.oni_season || detectSeason(w.synergy_skills) : "";

export function makeBaseline(warlords: Warlord[], label: string, now = new Date()): UpdateBaseline {
  const out: Record<string, BaselineEntry> = {};
  for (const w of warlords) {
    out[w.id] = {
      name: w.name,
      title_alias: w.title_alias,
      faction: w.faction,
      is_special: w.is_special,
      is_meisho: Boolean(w.is_meisho),
      oni_season: effectiveSeason(w),
      has_weapon_awakening: Boolean(w.has_weapon_awakening),
    };
  }
  return { started_at: now.toISOString(), label, warlords: out };
}

export interface UpdateDiff {
  /** 新しく登録された武将 (鬼憑武将も含む) */
  added: Warlord[];
  /** 名前・二つ名が変わった武将 */
  renamed: { warlord: Warlord; from: BaselineEntry }[];
  /** 新しく名将になった武将 (前からいた武将) */
  newMeisho: Warlord[];
  /** 専用武器覚醒が追加された武将 (前からいた武将) */
  newWeaponAwakening: Warlord[];
  /** シーズンが変わった・新しく分かった鬼憑武将 (前からいた武将) */
  seasonChanged: { warlord: Warlord; from: string; to: string }[];
  /** 基準の時には無かった鬼のシーズン */
  newSeasons: string[];
  /** 基準にいたのに、今はいない武将 (消した・まとめた) */
  removed: BaselineEntry[];
}

export function diffUpdate(base: UpdateBaseline, warlords: Warlord[]): UpdateDiff {
  const now = new Map(warlords.map((w) => [w.id, w]));
  const diff: UpdateDiff = { added: [], renamed: [], newMeisho: [], newWeaponAwakening: [], seasonChanged: [], newSeasons: [], removed: [] };
  for (const w of warlords) {
    const b = base.warlords[w.id];
    if (!b) {
      diff.added.push(w);
      continue;
    }
    if (b.name !== w.name || b.title_alias !== w.title_alias) diff.renamed.push({ warlord: w, from: b });
    if (!b.is_meisho && w.is_meisho) diff.newMeisho.push(w);
    if (b.has_weapon_awakening === false && w.has_weapon_awakening) diff.newWeaponAwakening.push(w);
    const season = effectiveSeason(w);
    if (season && season !== b.oni_season) diff.seasonChanged.push({ warlord: w, from: b.oni_season, to: season });
  }
  for (const [id, b] of Object.entries(base.warlords)) if (!now.has(id)) diff.removed.push(b);
  const before = new Set(Object.values(base.warlords).map((b) => b.oni_season).filter(Boolean));
  const after = new Set(warlords.map(effectiveSeason).filter(Boolean));
  diff.newSeasons = [...after].filter((s) => !before.has(s)).sort((a, b) => a.localeCompare(b, "ja"));
  const byName = (a: Warlord, b: Warlord) => a.faction.localeCompare(b.faction, "ja") || a.name.localeCompare(b.name, "ja");
  diff.added.sort(byName);
  diff.newMeisho.sort(byName);
  diff.newWeaponAwakening.sort(byName);
  return diff;
}

/** 変わった所が 1 つでもあるか */
export const hasChanges = (d: UpdateDiff) =>
  d.added.length + d.renamed.length + d.newMeisho.length + d.newWeaponAwakening.length + d.seasonChanged.length + d.newSeasons.length + d.removed.length > 0;

const label = (w: { name: string; is_special: boolean; title_alias?: string; faction: string }) =>
  `${w.is_special ? "【特】" : ""}${w.name}${w.title_alias ? `（${w.title_alias}）` : ""} [${w.faction || "勢力未入力"}]`;

/**
 * 変わった所のまとめ (読む用)。details: 新しい武将・名将になった武将などの詳しい内容 (武将のテキスト)
 * renameHints: 新しく登録された武将のうち、前からいた武将と立ち絵がほぼ同じもの (名前が変わったかもしれない)
 */
export function updateToText(
  base: UpdateBaseline,
  d: UpdateDiff,
  details: (w: Warlord) => string,
  renameHints: { added: Warlord; existing: Warlord }[] = [],
  now = new Date(),
): string {
  const lines: string[] = [];
  lines.push(`${base.label || "ゲームのアップデート"} の変更点`);
  lines.push(`(取り込み開始 ${base.started_at.slice(0, 10)} → 書き出し ${now.toISOString().slice(0, 10)})`);
  lines.push("");
  lines.push(
    `新しい武将 ${d.added.length} 人 / 名将になった武将 ${d.newMeisho.length} 人 / 武器覚醒の追加 ${d.newWeaponAwakening.length} 人 / 名前の変更 ${d.renamed.length} 人 / 鬼のシーズンの変更 ${d.seasonChanged.length} 人 / 新しい鬼のシーズン ${d.newSeasons.length}`,
  );
  if (!hasChanges(d)) {
    lines.push("", "変わった所はありません。");
    return lines.join("\n") + "\n";
  }
  const section = (title: string) => lines.push("", `■ ${title}`);
  if (d.newSeasons.length) {
    section("新しい鬼のシーズン");
    for (const s of d.newSeasons) {
      const members = d.added.concat(d.seasonChanged.map((x) => x.warlord)).filter((w) => effectiveSeason(w) === s);
      lines.push(`・${s}${members.length ? `: ${members.map((w) => w.name).join("、")}` : ""}`);
    }
  }
  if (d.renamed.length) {
    section("名前の変更");
    for (const r of d.renamed) lines.push(`・${label(r.from)} → ${label(r.warlord)}`);
  }
  if (renameHints.length) {
    section("名前が変わったかもしれない武将 (新しく登録されたが、前からいた武将と立ち絵がほぼ同じ)");
    for (const h of renameHints) lines.push(`・${label(h.existing)} → ${label(h.added)} ?`);
  }
  if (d.newMeisho.length) {
    section("名将になった武将");
    for (const w of d.newMeisho) lines.push(`・${label(w)}`);
  }
  if (d.newWeaponAwakening.length) {
    section("専用武器覚醒が追加された武将");
    for (const w of d.newWeaponAwakening) lines.push(`・${label(w)}${w.awakening_after_weapon ? `: ${w.awakening_after_weapon}` : " (武器覚醒後の効果はまだ読み取れていません)"}`);
  }
  if (d.seasonChanged.length) {
    section("鬼のシーズンの変更");
    for (const s of d.seasonChanged) lines.push(`・${label(s.warlord)}: ${s.from || "不明"} → ${s.to}`);
  }
  if (d.removed.length) {
    section("図鑑から消えた武将 (消した・ほかの武将にまとめた)");
    for (const b of d.removed) lines.push(`・${label(b)}`);
  }
  if (d.added.length) {
    section("新しい武将");
    for (const w of d.added) lines.push(`・${label(w)}${w.faction === "鬼憑武将" && effectiveSeason(w) ? ` (${effectiveSeason(w)})` : ""}`);
  }
  // 詳しい内容: 新しい武将と、名将になった・武器覚醒が追加された武将
  const detailed = [...new Set([...d.added, ...d.newMeisho, ...d.newWeaponAwakening])];
  if (detailed.length) {
    section("詳しい内容 (新しい武将・名将になった武将・武器覚醒が追加された武将)");
    lines.push("");
    lines.push(detailed.map(details).join("\n\n" + "─".repeat(24) + "\n\n"));
  }
  return lines.join("\n") + "\n";
}
