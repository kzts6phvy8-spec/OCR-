// 図鑑データの自動点検。おかしな所を探し、安全に直せるものは直し方 (fix) を付けて返す。
// 直せないもの (読み違いの疑いなど) は、利用者が確かめられるよう知らせるだけにする。

import type { OcrJob, Warlord } from "./types.ts";
import { mergeSynergies } from "./domain.ts";
import { compatible } from "./ingest.ts";
import { ONI_FACTION, isOniSynergy } from "./oni.ts";

export type IssueKind =
  | "duplicate"
  | "mixed_art"
  | "too_many_images"
  | "synergy_duplicate"
  | "oni_synergy"
  | "hime_special"
  | "awakening_rarity"
  | "talent_duplicate"
  | "odd_stat"
  | "missing_image"
  | "orphan_image"
  | "failed_jobs";

export interface Issue {
  kind: IssueKind;
  /** 自動で直せるか (直せるものは点検のたびに直す) */
  autoFix: boolean;
  message: string;
  warlordIds: string[];
  /** 自動で直す時の中身 (画像の掃除など) */
  imageIds?: string[];
}

/** 1 人の武将に統合される画像は多くても 6 枚 (それより多ければ、別の武将の画像が混ざっている) */
export const MAX_IMAGES_PER_WARLORD = 6;

const label = (w: Warlord) => `${w.is_special ? "【特】" : ""}${w.name}${w.faction ? ` (${w.faction})` : ""}`;
const growthNumber = (g: string) => Math.abs(parseFloat(g.replace(/[^\d.+-]/g, "")) || 0);

/**
 * imageIds: 端末に保存されている画像。recentImageIds: 保存したばかりの画像 (解析待ちに入る前かもしれないので、使われていなくても消さない)
 */
export function findIssues(warlords: Warlord[], imageIds: Set<string>, jobs: OcrJob[], recentImageIds: Set<string> = new Set()): Issue[] {
  const issues: Issue[] = [];

  // 同じ武将が 2 人に分かれていそう (名前・通常/特異・勢力の区分・物語武将のレア度が同じ)
  const seen = new Set<string>();
  for (const a of warlords) {
    if (seen.has(a.id)) continue;
    // 勢力がどちらも入っていて違えば別の武将 (限定武将・鬼憑武将などの別版や、別の地方の同名の武将)
    const sameFaction = (b: Warlord) => !a.faction || !b.faction || a.faction === b.faction;
    const group = warlords.filter(
      (b) =>
        b.name === a.name &&
        b.is_special === a.is_special &&
        sameFaction(b) &&
        compatible(b, a.faction, a.rarity) &&
        compatible(a, b.faction, b.rarity),
    );
    if (group.length < 2) continue;
    group.forEach((g) => seen.add(g.id));
    issues.push({
      kind: "duplicate",
      autoFix: false,
      message: `「${label(a)}」が ${group.length} 人に分かれています。同じ武将なら、武将の画面の「まとめる」でまとめてください (立ち絵が違う別の武将なら、そのままで大丈夫です)`,
      warlordIds: group.map((g) => g.id),
    });
  }

  for (const w of warlords) {
    // 画像が多すぎる = 別の武将の画像が混ざっている
    if (w.gallery_images.length > MAX_IMAGES_PER_WARLORD) {
      issues.push({
        kind: "too_many_images",
        autoFix: false,
        message: `「${label(w)}」に画像が ${w.gallery_images.length} 枚あります (1 人の武将は多くても ${MAX_IMAGES_PER_WARLORD} 枚)。別の武将の画像が混ざっています。「立ち絵ごとに分ける」で分けてください`,
        warlordIds: [w.id],
      });
    }
    // 同じ連携スキルが重なっている
    if (mergeSynergies([], w.synergy_skills).length < w.synergy_skills.length) {
      issues.push({ kind: "synergy_duplicate", autoFix: true, message: `「${label(w)}」の連携スキルの重なりをまとめました`, warlordIds: [w.id] });
    }
    // 鬼に、鬼の連携ではない連携スキルが混ざっている
    if (w.faction === ONI_FACTION && w.synergy_skills.some((s) => !isOniSynergy(s))) {
      issues.push({ kind: "oni_synergy", autoFix: true, message: `「${label(w)}」に混ざっていた、鬼の連携ではない連携スキルを取り除きました`, warlordIds: [w.id] });
    }
    // 姫武将が特異武将になっている
    if (w.faction === "姫武将" && w.is_special) {
      issues.push({ kind: "hime_special", autoFix: true, message: `「${label(w)}」を特異武将から姫武将に戻しました`, warlordIds: [w.id] });
    }
    // SR・R・N には覚醒スキルが無いのに入っている (読み違いか、別の武将の情報が混ざった)
    if (["SR", "R", "N"].includes(w.rarity) && (w.awakening_skill_name || w.awakening_before_weapon)) {
      issues.push({
        kind: "awakening_rarity",
        autoFix: false,
        message: `「${label(w)}」は ${w.rarity} なのに覚醒スキルが入っています。レア度の読み違いか、別の武将の情報が混ざっていないか確かめてください`,
        warlordIds: [w.id],
      });
    }
    // 同じ星の天賦が 2 つ以上
    const stars = w.talents.map((t) => t.star_level);
    if (new Set(stars).size < stars.length) {
      issues.push({ kind: "talent_duplicate", autoFix: false, message: `「${label(w)}」に同じ星の天賦が 2 つ以上あります。読み違いがないか確かめてください`, warlordIds: [w.id] });
    }
    // ありえない数値 (読み違いの疑い)
    const growths = [w.attack_growth, w.defense_growth, w.stratagem_growth, w.troops_growth].map(growthNumber);
    const bases = [w.attack_base, w.defense_base, w.stratagem_base, w.troops_base];
    if (growths.some((g) => g > 10) || bases.some((b) => b > 5000)) {
      issues.push({ kind: "odd_stat", autoFix: false, message: `「${label(w)}」の成長値に、ありえない数値があります。読み違いがないか確かめてください`, warlordIds: [w.id] });
    }
    // 画像の記録はあるのに、画像そのものが無い
    const missing = w.gallery_images.filter((id) => !imageIds.has(id));
    if (missing.length) {
      issues.push({
        kind: "missing_image",
        autoFix: true,
        message: `「${label(w)}」の見つからない画像 ${missing.length} 枚の記録を外しました`,
        warlordIds: [w.id],
        imageIds: missing,
      });
    }
  }

  // どの武将にも解析待ちにも使われていない画像 (容量だけを使っている)
  const used = new Set<string>();
  for (const w of warlords) [w.image_url, ...w.gallery_images].forEach((id) => used.add(id));
  for (const j of jobs) if (j.status !== "done" || j.keep_image) used.add(j.image_id);
  const orphans = [...imageIds].filter((id) => !used.has(id) && !recentImageIds.has(id));
  if (orphans.length) {
    issues.push({ kind: "orphan_image", autoFix: true, message: `どこにも使われていない画像 ${orphans.length} 枚を消して、容量を空けました`, warlordIds: [], imageIds: orphans });
  }

  const failed = jobs.filter((j) => j.status === "error");
  if (failed.length) {
    issues.push({
      kind: "failed_jobs",
      autoFix: false,
      message: `解析に失敗したスクショが ${failed.length} 枚あります。「スクショ解析」タブで再試行するか、「統合先を選んで保存」で武将を選んでください`,
      warlordIds: [],
    });
  }
  return issues;
}
