// 鬼憑武将のシーズン (4 人ずつの組)。利用者に教えてもらった一覧。
// 連携スキルの文章 (「鬼憑徳川四天王2体以上が場内にいる場合…」など) にシーズンの名前が出てくれば、そのシーズンとみなす。

export const ONI_SEASONS = [
  "川中島合戦",
  "源平合戦",
  "紅夜忍法帖",
  "徳川四天王",
  "島津四兄弟",
  "門司城合戦",
  "関ヶ原合戦",
  "乱世名夫人",
  "毛利両川",
  "大阪夏の陣",
  "豊臣出世",
  "風雲桶狭間",
  "武田四天王",
  "慶長出羽",
  "上杉四天王",
  "織田四天王",
] as const;

const norm = (s: string) => s.normalize("NFKC").replace(/[\s・]/g, "").replace(/ケ/g, "ヶ").replace(/大坂/g, "大阪");

/** 文章に出てくるシーズンの名前 (無ければ空文字) */
export function seasonInText(text: string): string {
  const t = norm(text);
  return ONI_SEASONS.find((s) => t.includes(norm(s))) ?? "";
}

/**
 * 鬼の連携スキルの文章から、シーズンを見つける。「鬼憑徳川四天王」のように「鬼憑」の直後にシーズン名がある時だけ
 * (「徳川四天王」「毛利両川」などは普通の武将の連携スキルにも出てくるので、名前だけでは鬼のシーズンとみなさない)。
 */
export function oniSeasonInText(text: string): string {
  const t = norm(text);
  return ONI_SEASONS.find((s) => t.includes(`鬼憑${norm(s)}`)) ?? "";
}

/** 連携スキルからシーズンを見つける (「鬼憑 + シーズン名」がある時だけ) */
export function detectSeason(synergies: { partner: string; effect: string }[]): string {
  for (const s of synergies) {
    const found = oniSeasonInText(`${s.partner} ${s.effect}`);
    if (found) return found;
  }
  return "";
}

/** 保存できるシーズンの名前にそろえる (一覧に無ければ空文字) */
export const normalizeSeason = (v: unknown) => seasonInText(String(v ?? ""));
