// 図鑑データの自動点検。知らせるのは次の 2 つだけ (利用者の指定):
// - 画像が 7 枚以上: 1 人の武将に統合される画像は多くても 6 枚なので、別の武将の画像が混ざっている
// - 画像が 1 枚だけ: ほかの画面 (天賦・連携など) のスクショがまだ足りない

import type { Warlord } from "./types.ts";

export type IssueKind = "too_many_images" | "single_image";

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
  return issues;
}
