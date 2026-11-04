// 図鑑データの自動点検。知らせるのは次のものだけ (利用者の指定):
// - 画像が 7 枚以上: 1 人の武将に統合される画像は多くても 6 枚なので、別の武将の画像が混ざっている
// - 画像が 1 枚だけ: ほかの画面 (天賦・連携など) のスクショがまだ足りない
// - 鬼憑武将の組 (同じシーズンの 4 人) に、図鑑にまだ登録されていない鬼がいる

import type { Warlord } from "./types.ts";
import { splitPartners } from "./domain.ts";

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

/** 鬼憑武将の組ごとに、図鑑に登録されている鬼が 4 人そろっているかを調べる */
function findOniGroupIssues(warlords: Warlord[]): Issue[] {
  const onis = warlords.filter((w) => w.faction === ONI);
  const oniNames = new Set(onis.map((w) => w.name));
  const issues: Issue[] = [];

  const groupsOf = (w: Warlord) => new Set(w.synergy_skills.map((s) => oniGroupName(s.partner, s.effect)).filter(Boolean));

  // 鬼の組の連携スキルがあるのに、勢力が「鬼憑武将」になっていない武将 (組の人数には数える)
  const notOni = warlords.filter((w) => w.faction !== ONI && groupsOf(w).size > 0);
  for (const w of notOni) {
    issues.push({
      kind: "oni_group_incomplete",
      autoFix: false,
      message: `「${w.is_special ? "【特】" : ""}${w.name}」は鬼の組「${[...groupsOf(w)].join("・")}」の連携スキルがあるのに、勢力が「鬼憑武将」になっていません (今: ${w.faction || "未入力"})`,
      warlordIds: [w.id],
    });
  }

  // 鬼憑武将なのに、組が分かる連携スキルが無い鬼 (組の人数に数えられない)
  for (const w of onis) {
    if (w.no_synergy || groupsOf(w).size > 0) continue;
    if (w.synergy_skills.some((s) => splitPartners(s.partner).some((n) => oniNames.has(n) && n !== w.name))) continue; // 相手の名前で組が分かる
    const label = `${w.is_special ? "【特】" : ""}${w.name}`;
    const nonOni = w.synergy_skills.filter((s) => !/鬼/.test(s.partner + s.effect));
    if (nonOni.length > 0) {
      // 鬼の組ではない連携スキル (例: 特異の猿飛佐助と出浦) がある = この武将は鬼ではなく、勢力の読み違いのはず
      issues.push({
        kind: "oni_group_incomplete",
        autoFix: false,
        message: `「${label}」は勢力が「鬼憑武将」ですが、連携スキル (${nonOni.map((s) => s.partner).join("、")}) が鬼の組ではありません。同じ名前の鬼とは別の武将なら、勢力を直してください`,
        warlordIds: [w.id],
      });
      continue;
    }
    issues.push({
      kind: "oni_group_incomplete",
      autoFix: false,
      message: w.is_special
        ? `「${label}」は特異武将なのに勢力が「鬼憑武将」で、連携スキルもありません。同じ名前の鬼とは別の武将なら、勢力を直してください。鬼なら連携スキルの画面を足してください`
        : `鬼「${label}」の連携スキルがまだ読み取れていないので、どの組か分かりません (組の人数に数えていません)。連携スキルの画面を「スクショを追加して統合」で足してください`,
      warlordIds: [w.id],
    });
  }

  // 組の名前 (鬼憑徳川四天王 など) で書かれた連携スキル: 同じ組の名前を持つ鬼を数える
  const byGroup = new Map<string, Warlord[]>();
  for (const w of [...onis, ...notOni]) {
    for (const g of groupsOf(w)) byGroup.set(g, [...(byGroup.get(g) ?? []), w]);
  }
  for (const [group, members] of byGroup) {
    const unique = [...new Map(members.map((m) => [m.name, m])).values()];
    if (unique.length >= ONI_GROUP_SIZE) continue;
    issues.push({
      kind: "oni_group_incomplete",
      autoFix: false,
      message: `鬼の組「${group}」で図鑑に登録されているのは ${unique.map((m) => m.name).join("・")} の ${unique.length} 人です。あと ${ONI_GROUP_SIZE - unique.length} 人が登録されていません`,
      warlordIds: unique.map((m) => m.id),
    });
  }

  // 連携相手に武将名が並んでいる連携スキル: その名前の鬼が登録されているかを調べる
  const reported = new Set<string>();
  for (const w of onis) {
    for (const s of w.synergy_skills) {
      if (oniGroupName(s.partner, s.effect)) continue;
      const missing = splitPartners(s.partner).filter((n) => n !== w.name && !oniNames.has(n));
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
