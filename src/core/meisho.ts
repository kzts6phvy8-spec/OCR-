// 名将の一覧 (ゲーム内「名将問屋 → 名将一覧」を書き写したもの。利用者のスクショから)。
// 勢力ごとのタブに並ぶ武将。同じ名前でも勢力が違えば別の武将 (例: コラボの徳川家康と東海の徳川家康)。
// 同じ勢力に同じ名前が 2 人並ぶもの (東海の江姫、奥.関.甲の前田利家) は、立ち絵の違う 2 人。

import type { Warlord } from "./types.ts";
import { normalizeName } from "./domain.ts";

export interface MeishoEntry {
  faction: string;
  name: string;
  /** 限定武将の見出し (例: 2024年正月限定) */
  group?: string;
}

const list = (faction: string, names: string[], group?: string): MeishoEntry[] => names.map((name) => ({ faction, name, ...(group ? { group } : {}) }));

export const MEISHO_ROSTER: MeishoEntry[] = [
  ...list("奥.関.甲", ["南部晴政", "南部信直", "武田信玄", "前田利家", "前田利家", "上杉謙信", "北条氏康", "真田信繁", "霧隠才蔵", "真田昌幸", "猿飛佐助", "真田幸村", "伊達政宗"]),
  ...list("東海", ["浄円院", "酒井忠次", "鷹司信子", "江姫", "徳川家康", "江姫", "斎藤道三", "織田信長", "森長可", "森蘭丸", "明智光秀", "太原雪斎"]),
  ...list("畿内", ["加藤清正", "大谷吉継", "豊臣秀吉", "松永久秀", "島左近", "足利義昭", "浅井茶々", "浅井長政"]),
  ...list("中.九", ["天草四郎", "ザビエル", "見性院", "鶴姫", "山中鹿介", "島津日新斎", "立花道雪"]),
  ...list("旧時代", ["日野富子", "平清盛", "建礼門院", "巴御前"]),
  ...list("限定武将", ["足利義政", "今川義元"], "2024年正月限定"),
  ...list("限定武将", ["加藤清正", "石田三成"], "文治武功"),
  ...list("限定武将", ["竹中半兵衛", "織田信長"], "稲葉山城合戦"),
  ...list("限定武将", ["北条政子", "大姫"]),
  ...list("限定武将", ["長宗我部元親", "甲斐姫"], "2024年春季限定"),
  ...list("限定武将", ["春日局", "足利義昭"], "2025年春季限定"),
  ...list("限定武将", ["霧隠才蔵", "義姫"], "2025年甘苦祭限定"),
  ...list("姫武将", ["フロイス", "鶴姫"]),
  ...list("コラボ武将", ["片倉小十郎", "徳川家康", "石田三成", "伊達政宗", "真田幸村"]),
];

/**
 * 突き合わせに使う勢力: コラボ武将は限定武将の仲間で、前の版で「限定武将」として登録されたコラボ武将もいるので、同じ組として扱う
 */
export const rosterFaction = (faction: string) => (faction === "コラボ武将" ? "限定武将" : faction);
const key = (faction: string, name: string) => `${rosterFaction(faction)}|${normalizeName(name).name}`;

/** 名将一覧に名前が載っている (勢力は問わない) */
export const ROSTER_NAMES = new Set(MEISHO_ROSTER.map((e) => e.name));

export interface MeishoMatch {
  faction: string;
  name: string;
  group?: string;
  /** 一覧に並ぶ人数 (同じ勢力・同じ名前) */
  count: number;
  /** 図鑑で見つかった武将 */
  candidates: Warlord[];
  /** 名将と決められた武将 (候補が一覧の人数と同じ時だけ。多い時は立ち絵で選んでもらう) */
  decided: Warlord[];
}

/** 名将の一覧と図鑑の武将を、勢力と名前で突き合わせる */
export function matchMeishoRoster(warlords: Warlord[]): MeishoMatch[] {
  const counts = new Map<string, MeishoEntry & { count: number }>();
  for (const e of MEISHO_ROSTER) {
    const k = key(e.faction, e.name);
    const cur = counts.get(k);
    counts.set(k, cur ? { ...cur, count: cur.count + 1 } : { ...e, count: 1 });
  }
  const byKey = new Map<string, Warlord[]>();
  for (const w of warlords) {
    const k = key(w.faction, w.name);
    if (counts.has(k)) byKey.set(k, [...(byKey.get(k) ?? []), w]);
  }
  return [...counts.entries()].map(([k, e]) => {
    const candidates = byKey.get(k) ?? [];
    return { faction: e.faction, name: e.name, group: e.group, count: e.count, candidates, decided: candidates.length > 0 && candidates.length <= e.count ? candidates : [] };
  });
}
