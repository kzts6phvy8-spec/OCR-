import type { Talent, Warlord } from "./types.ts";

// 武将データを読みやすいテキストにする (コピー・.txt 書き出し用)。
// 利用者が普段使っている書式に合わせている。

/** 天賦の表示名: 名前が無い (効果だけの) 天賦は効果のみ */
export function talentText(t: Talent): string {
  if (!t.name || t.effect.startsWith(t.name)) return t.effect;
  return t.effect ? `${t.name} ${t.effect}` : t.name;
}

const skillLine = (name: string, desc: string) => [name && `『${name}』`, desc].filter(Boolean).join("");

export function warlordToText(w: Warlord): string {
  const lines: string[] = [];
  lines.push(`武将名:${w.name}${w.is_special ? " (特異)" : ""}`);
  if (w.title_alias) lines.push(`二つ名:${w.title_alias}`);

  if (w.skill_name || w.skill_desc) {
    lines.push(`奥義スキル${w.skill_gauge ? `（奥義ゲージ${w.skill_gauge}）` : ""}: ${skillLine(w.skill_name, w.skill_desc)}`);
  }
  if (w.has_awakening) {
    lines.push(`覚醒スキル${w.awakening_priority ? `（${w.awakening_priority}）` : ""}: ${skillLine(w.awakening_skill_name, w.awakening_before_weapon)}`);
    if (w.has_weapon_awakening && w.awakening_after_weapon) lines.push(`武器覚醒後: ${w.awakening_after_weapon}`);
  }
  if (w.talents.length) {
    w.talents.forEach((t, i) => lines.push(`${i === 0 ? "天賦:" : ""}星${t.star_level}${talentText(t)}${t.unlocked ? "" : " (未解放)"}`));
  }
  const troops = w.troop_variants.length ? w.troop_variants : w.troop_type ? [w.troop_type] : [];
  if (troops.length) lines.push(`兵種:${troops.join("、")}`);
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

export function warlordsToText(list: Warlord[]): string {
  return `戦国布武 武将図鑑 (${list.length} 件)\n\n` + list.map(warlordToText).join("\n\n" + "─".repeat(24) + "\n\n") + "\n";
}
