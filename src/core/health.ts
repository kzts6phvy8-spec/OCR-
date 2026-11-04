// 図鑑データの自動点検。知らせるのは次のものだけ (利用者の指定):
// - 画像が 7 枚以上: 1 人の武将に統合される画像は多くても 6 枚なので、別の武将の画像が混ざっている
// - 画像が 1 枚だけ: ほかの画面 (天賦・連携など) のスクショがまだ足りない
// - 鬼憑武将の組 (同じシーズンの 4 人) に、図鑑にまだ登録されていない鬼がいる

import type { Warlord } from "./types.ts";
import { splitPartners } from "./domain.ts";
import { detectSeason, seasonInText } from "./seasons.ts";

export type IssueKind = "too_many_images" | "single_image" | "oni_group_incomplete";

const ONI = "鬼憑武将";
/** 鬼憑武将は毎シーズン 4 人ずつ。連携スキルはその 4 人の間で起こる */
export const ONI_GROUP_SIZE = 4;

/** 連携スキルに書かれた鬼の組の名前 (「鬼憑徳川四天王2体以上が場内にいる場合…」の「鬼憑徳川四天王」) */
export function oniGroupName(partner: string, effect: string): string {
  for (const text of [partner, effect]) {
    const t = text.normalize("NFKC");
    const m = t.match(/(鬼憑[^\s、,，。0-9]+?)(?=\s*\d+\s*体)/) ?? t.match(/^(鬼憑[^\s、,，。0-9]+)$/);
    if (m) return m[1];
  }
  return "";
}

export interface Issue {
  kind: IssueKind;
  /** 自動で直せるか (今の点検では、どれも知らせるだけ) */
  autoFix: boolean;
  message: string;
  warlordIds: string[];
}

/** 1 人の武将に統合される画像は多くても 6 枚 (それより多ければ、別の武将の画像が混ざっている) */
export const MAX_IMAGES_PER_WARLORD = 6;

const label = (w: Warlord) => `${w.is_special ? "【特】" : ""}${w.name}${w.faction ? ` (${w.faction})` : ""}`;

export function findIssues(warlords: Warlord[]): Issue[] {
  const issues: Issue[] = [];
  for (const w of warlords) {
    if (w.gallery_images.length > MAX_IMAGES_PER_WARLORD) {
      issues.push({
        kind: "too_many_images",
        autoFix: false,
        message: `「${label(w)}」に画像が ${w.gallery_images.length} 枚あります (1 人の武将は多くても ${MAX_IMAGES_PER_WARLORD} 枚)。別の武将の画像が混ざっています。「立ち絵ごとに分ける」で分けてください`,
        warlordIds: [w.id],
      });
    } else if (w.gallery_images.length === 1) {
      issues.push({
        kind: "single_image",
        autoFix: false,
        message: `「${label(w)}」の画像が 1 枚だけです。ほかの画面のスクショを「スクショを追加して統合」で足してください`,
        warlordIds: [w.id],
      });
    }
  }
  issues.push(...findOniGroupIssues(warlords));
  return issues;
}

/** 鬼憑武将のシーズン (4 人の組) ごとに、図鑑に登録されている鬼が 4 人そろっているかを調べる */
function findOniGroupIssues(warlords: Warlord[]): Issue[] {
  const onis = warlords.filter((w) => w.faction === ONI);
  const oniNames = new Set(onis.map((w) => w.name));
  const issues: Issue[] = [];
  const labelOf = (w: Warlord) => `${w.is_special ? "【特】" : ""}${w.name}`;
  const hasOniSynergy = (w: Warlord) => w.synergy_skills.some((s) => /鬼/.test(s.partner + s.effect));

  // 鬼の組の連携スキルがあるのに、勢力が「鬼憑武将」になっていない武将
  for (const w of warlords) {
    if (w.faction === ONI) continue;
    const season = detectSeason(w.synergy_skills);
    const group = w.synergy_skills.map((s) => oniGroupName(s.partner, s.effect)).find(Boolean);
    if (!season && !group) continue;
    issues.push({
      kind: "oni_group_incomplete",
      autoFix: false,
      message: `「${labelOf(w)}」は鬼の組「${season || group}」の連携スキルがあるのに、勢力が「鬼憑武将」になっていません (今: ${w.faction || "未入力"})`,
      warlordIds: [w.id],
    });
  }

  const seasonOf = resolveOniSeasons(onis);
  const byName = new Map(onis.map((w) => [w.name, w]));

  // シーズンが分からない鬼: 連携スキルのつながり (組の名前・「鬼憑 + 武将名」・相手の名前) でまとめ、4 人そろっていれば知らせない
  const unknown: Warlord[] = [];
  for (const w of onis) {
    if (seasonOf.has(w.id) || w.no_synergy) continue;
    const nonOni = w.synergy_skills.filter((s) => !/鬼/.test(s.partner + s.effect));
    if (nonOni.length > 0 && !hasOniSynergy(w)) {
      // 鬼の組ではない連携スキル (例: 特異の猿飛佐助と出浦) だけ = この武将は鬼ではなく、勢力の読み違いのはず
      issues.push({
        kind: "oni_group_incomplete",
        autoFix: false,
        message: `「${labelOf(w)}」は勢力が「鬼憑武将」ですが、連携スキル (${nonOni.map((s) => s.partner).join("、")}) が鬼の組ではありません。同じ名前の鬼とは別の武将なら、勢力を直してください`,
        warlordIds: [w.id],
      });
      continue;
    }
    unknown.push(w);
  }
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  const link = (x: string, y: string) => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  };
  const unknownNames = new Set(unknown.map((w) => w.name));
  for (const w of unknown) {
    find(w.name);
    for (const s of w.synergy_skills) {
      const g = oniGroupName(s.partner, s.effect);
      const refs = [...splitPartners(s.partner), g].filter(Boolean).map((n) => n.replace(/^鬼憑/, ""));
      for (const n of refs) {
        if (n !== w.name && unknownNames.has(n)) link(w.name, n);
      }
      if (g && !unknownNames.has(g.replace(/^鬼憑/, ""))) link(w.name, `組:${g}`);
    }
  }
  const components = new Map<string, Warlord[]>();
  for (const w of unknown) components.set(find(w.name), [...(components.get(find(w.name)) ?? []), w]);
  for (const list of components.values()) {
    const unique = [...new Map(list.map((m) => [m.name, m])).values()];
    if (unique.length === ONI_GROUP_SIZE) continue;
    issues.push({
      kind: "oni_group_incomplete",
      autoFix: false,
      message:
        unique.length === 1
          ? `鬼「${labelOf(unique[0])}」のシーズンが分かりません (シーズンごとの人数に数えていません)。連携スキルの画面を「スクショを追加して統合」で足すか、編集で「シーズン」を選んでください`
          : `鬼 ${unique.map((m) => m.name).join("・")} の ${unique.length} 人は同じ組のようですが、シーズンが分からず、4 人もそろっていません。編集で「シーズン」を選んでください`,
      warlordIds: unique.map((m) => m.id),
    });
  }

  // シーズンごとに人数を数える (同じ名前の鬼は 1 人として)
  const bySeason = new Map<string, Warlord[]>();
  for (const w of onis) {
    const season = seasonOf.get(w.id);
    if (season) bySeason.set(season, [...(bySeason.get(season) ?? []), w]);
  }
  for (const [season, list] of bySeason) {
    const unique = [...new Map(list.map((m) => [m.name, m])).values()];
    if (unique.length === ONI_GROUP_SIZE) continue;
    issues.push({
      kind: "oni_group_incomplete",
      autoFix: false,
      message:
        unique.length < ONI_GROUP_SIZE
          ? `鬼のシーズン「${season}」で図鑑に登録されているのは ${unique.map((m) => m.name).join("・")} の ${unique.length} 人です。あと ${ONI_GROUP_SIZE - unique.length} 人が登録されていないか、シーズンが分かりません`
          : `鬼のシーズン「${season}」に ${unique.length} 人います (${unique.map((m) => m.name).join("・")})。1 シーズンは 4 人なので、シーズンの選び間違いがないか確かめてください`,
      warlordIds: unique.map((m) => m.id),
    });
  }

  // 連携相手に武将名が並んでいる連携スキル: その名前の鬼が登録されているかを調べる
  const reported = new Set<string>();
  for (const w of onis) {
    for (const s of w.synergy_skills) {
      if (oniGroupName(s.partner, s.effect)) continue;
      const missing = splitPartners(s.partner)
        .map((n) => n.replace(/^鬼憑/, ""))
        .filter((n) => n !== w.name && !oniNames.has(n) && !seasonInText(n));
      const key = [w.name, ...splitPartners(s.partner)].sort().join("、");
      if (missing.length === 0 || reported.has(key)) continue;
      reported.add(key);
      issues.push({
        kind: "oni_group_incomplete",
        autoFix: false,
        message: `鬼「${w.name}」の連携相手のうち、${missing.join("・")} が鬼憑武将として図鑑に登録されていません`,
        warlordIds: [w.id],
      });
    }
  }
  return issues;
}

/**
 * 鬼憑武将それぞれのシーズンを決める (武将 ID → シーズン)。
 * 選んだシーズン → 連携スキルの文章 → 連携スキルで指している鬼 (「鬼憑毛利元就」など) のシーズン
 * → この鬼を連携スキルで指している鬼のシーズン、の順に探す。
 */
export function resolveOniSeasons(onis: Warlord[]): Map<string, string> {
  const seasonOf = new Map<string, string>();
  for (const w of onis) {
    const s = w.oni_season || detectSeason(w.synergy_skills);
    if (s) seasonOf.set(w.id, s);
  }
  const byName = new Map(onis.map((w) => [w.name, w]));
  const refsOf = (w: Warlord) =>
    w.synergy_skills.flatMap((s) => [...splitPartners(s.partner), oniGroupName(s.partner, s.effect)]).map((n) => n.replace(/^鬼憑/, "")).filter(Boolean);
  for (let round = 0; round < 4; round++) {
    for (const w of onis) {
      if (seasonOf.has(w.id)) continue;
      const via =
        refsOf(w)
          .map((n) => byName.get(n))
          .find((o) => o && o.id !== w.id && seasonOf.has(o.id)) ??
        onis.find((o) => o.id !== w.id && seasonOf.has(o.id) && refsOf(o).includes(w.name));
      if (via) seasonOf.set(w.id, seasonOf.get(via.id)!);
    }
  }
  return seasonOf;
}
