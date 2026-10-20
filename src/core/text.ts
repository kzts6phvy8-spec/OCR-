import type { Warlord } from "./types.ts";

/** 武将データを読みやすいテキストにする (コピー・.txt 書き出し用) */
export function warlordToText(w: Warlord): string {
  const lines: string[] = [];
  const head = [w.rarity && `【${w.rarity}】`, w.name, w.is_special && " (特異)"].filter(Boolean).join("");
  lines.push(head);
  const meta = [
    w.faction && `勢力: ${w.faction}`,
    w.level > 0 && `Lv.${w.level}`,
    w.stars > 0 && `★${w.stars}`,
    w.title_alias && `二つ名: ${w.title_alias}`,
  ].filter(Boolean);
  if (meta.length) lines.push(meta.join(" / "));

  const stats = (
    [
      ["攻", w.attack_base, w.attack_growth],
      ["防", w.defense_base, w.defense_growth],
      ["計", w.stratagem_base, w.stratagem_growth],
      ["兵", w.troops_base, w.troops_growth],
    ] as const
  )
    .filter(([, base, growth]) => base || growth)
    .map(([label, base, growth]) => `${label} ${base || "-"}${growth ? ` (${growth})` : ""}`);
  if (w.growth_total || stats.length) {
    lines.push("");
    if (w.growth_total) lines.push(`成長値: ${w.growth_total}`);
    if (stats.length) lines.push(stats.join(" / "));
  }

  if (w.skill_name || w.skill_desc) {
    lines.push("", `■ 奥義スキル${w.skill_gauge ? ` (奥義ゲージ${w.skill_gauge})` : ""}: ${w.skill_name}`);
    if (w.skill_desc) lines.push(w.skill_desc);
  }
  if (w.has_awakening) {
    lines.push("", `■ 覚醒スキル${w.awakening_priority ? ` (${w.awakening_priority})` : ""}: ${w.awakening_skill_name}`);
    if (w.awakening_before_weapon) lines.push(w.has_weapon_awakening ? `[武器覚醒前] ${w.awakening_before_weapon}` : w.awakening_before_weapon);
    if (w.has_weapon_awakening && w.awakening_after_weapon) lines.push(`[武器覚醒後] ${w.awakening_after_weapon}`);
  }
  if (w.talents.length) {
    lines.push("", "■ 天賦");
    for (const t of w.talents) {
      lines.push(`★${t.star_level}${t.position ? ` ${t.position}` : ""} ${t.name}${t.unlocked ? "" : " (未解放)"}: ${t.effect}`);
    }
  }
  if (w.synergy_skills.length) {
    lines.push("", "■ 連携スキル");
    for (const s of w.synergy_skills) lines.push(`${s.partner}: ${s.effect}`);
  }
  if (w.troop_type || w.troop_variants.length) {
    lines.push("", `■ 兵種: ${w.troop_type || "-"}${w.troop_variants.length ? ` (選択可: ${w.troop_variants.join("、")})` : ""}`);
  }
  return lines.join("\n");
}

export function warlordsToText(list: Warlord[]): string {
  const sep = "\n\n" + "─".repeat(24) + "\n\n";
  return `戦国布武 武将図鑑 (${list.length} 件)\n\n` + list.map(warlordToText).join(sep) + "\n";
}
