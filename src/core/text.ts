import { meishoTalentGaps } from "./missing.ts";
import type { ApexNode, Talent, Warlord } from "./types.ts";

// 武将データを読みやすいテキストにする (コピー・.txt 書き出し用)。
// 利用者が普段使っている書式に合わせている。

/** 天賦の表示名: 名前が無い (効果だけの) 天賦は効果のみ */
export function talentText(t: Talent): string {
  if (!t.name || t.effect.startsWith(t.name)) return t.effect;
  return t.effect ? `${t.name} ${t.effect}` : t.name;
}

const skillLine = (name: string, desc: string) => [name && `『${name}』`, desc].filter(Boolean).join("");

/** 頂天突破の丸 1 つのテキスト */
export function apexNodeText(n: ApexNode): string {
  const head = `${n.rank || "官職不明"} ${n.size}`;
  const title = n.title && n.title !== "追加天賦" ? `『${n.title}』` : "";
  return `${head}:${title}${n.effect}${n.cost ? ` [${n.cost}]` : ""}`;
}

export function warlordToText(w: Warlord): string {
  const lines: string[] = [];
  lines.push(`武将名:${w.name}${w.is_special ? " (特異)" : ""}`);
  if (w.title_alias) lines.push(`二つ名:${w.title_alias}`);

  if (w.skill_name || w.skill_desc) {
    lines.push(`奥義スキル${w.skill_gauge ? `（奥義ゲージ${w.skill_gauge}）` : ""}: ${skillLine(w.skill_name, w.skill_desc)}`);
  }
  const apex = w.faction === "頂点武将";
  if (w.has_awakening) {
    lines.push(`${apex ? "突破スキル" : "覚醒スキル"}${w.awakening_priority ? `（${w.awakening_priority}）` : ""}: ${skillLine(w.awakening_skill_name, w.awakening_before_weapon)}`);
    if (w.has_weapon_awakening && w.awakening_after_weapon) lines.push(`武器覚醒後: ${w.awakening_after_weapon}`);
  }
  if (w.passive_skill) lines.push(`受動スキル: ${w.passive_skill}`);
  if (w.talents.length) {
    // 「星1:物理防御+30%」の形で、効果と数値だけを並べる
    lines.push("天賦");
    for (const t of [...w.talents].sort((a, b) => a.star_level - b.star_level)) lines.push(`星${t.star_level}:${talentText(t)}`);
  }
  if (w.meisho_talents?.length) {
    // 「少史 上:兵数上限+175 (未修行)」の形
    lines.push("名将修行");
    for (const t of w.meisho_talents) lines.push(`${t.rank}${t.slot ? ` ${t.slot}` : ""}:${t.effect}`);
  }
  if (w.apex_nodes?.length) {
    // 「少史 大『突破スキル(辛·8)』…[50]」の形 (官職の順・大 → 小)
    lines.push("頂天突破");
    for (const n of w.apex_nodes) lines.push(apexNodeText(n));
  }
  if (w.meisho_awakening?.length) {
    lines.push("名将覚醒 (名将の道)");
    for (const n of w.meisho_awakening) lines.push(`${n.rank}${n.slot ? ` ${n.slot}` : ""}『${n.title}』${n.effect}`);
  }
  if (w.troop_variants.length) lines.push(`兵種:${w.troop_variants.join("、")}`);
  if (w.rarity) lines.push(`レア度:${w.rarity}`);
  if (w.faction) lines.push(`勢力:${w.faction}`);
  if (w.level > 0 || w.stars > 0) lines.push([w.level > 0 && `Lv.${w.level}`, w.stars > 0 && `★${w.stars}`].filter(Boolean).join(" "));

  if (w.synergy_skills.length) {
    lines.push("連携スキル");
    for (const s of w.synergy_skills) {
      // 効果文に相手の名前が含まれていない古いデータは「相手: 効果」と書く
      lines.push(s.effect.includes(s.partner) ? s.effect : `${s.partner}: ${s.effect}`);
    }
  }

  // 値のある能力だけを「攻：92 （+2.3）計：96 （+2.5）」の形で並べる
  const stat = (label: string, base: number, growth: string) =>
    base || growth ? `${label}：${base || "-"}${growth ? ` （${growth}）` : ""}` : "";
  if (w.growth_total) lines.push(`成長値：${w.growth_total}`);
  const row1 = [stat("攻", w.attack_base, w.attack_growth), stat("計", w.stratagem_base, w.stratagem_growth)].filter(Boolean).join("");
  const row2 = [stat("防", w.defense_base, w.defense_growth), stat("兵", w.troops_base, w.troops_growth)].filter(Boolean).join(" ");
  if (row1) lines.push(row1);
  if (row2) lines.push(row2);
  return lines.join("\n");
}

/**
 * 名将修行の追加天賦だけのテキスト。勢力ごとに、武将名と官職ごとの追加天賦を並べる
 * (まだ読み取っていない武将は「未取得」)
 */
export function meishoTrainingToText(list: Warlord[]): string {
  const done = list.filter((w) => w.meisho_talents?.length).length;
  const lines = [`名将修行 追加天賦 (${list.length} 人・読み取り済み ${done} 人)`, ""];
  let faction: string | null = null;
  for (const w of list) {
    if (w.faction !== faction) {
      faction = w.faction;
      lines.push(`■ ${faction || "勢力未入力"}`);
    }
    lines.push(`${w.is_special ? "【特】" : ""}${w.name}${w.title_alias ? `（${w.title_alias}）` : ""}`);
    if (!w.meisho_talents?.length) lines.push("  未取得");
    else if (w.meisho_source === "simulator") lines.push("  (シミュレーターに直接渡したデータ)");
    for (const t of w.meisho_talents ?? []) lines.push(`  ${t.rank}${t.slot ? ` ${t.slot}` : ""}:${t.effect}${t.estimated ? " (推定・名将全員同じ)" : ""}`);
    const gaps = w.meisho_talents?.length ? meishoTalentGaps(w) : [];
    if (gaps.length) lines.push(`  (足りない: ${gaps.join("、")})`);
    lines.push("");
  }
  return lines.join("\n");
}

export function warlordsToText(list: Warlord[]): string {
  return `開発用データ (${list.length} 件)\n\n` + list.map(warlordToText).join("\n\n" + "─".repeat(24) + "\n\n") + "\n";
}
