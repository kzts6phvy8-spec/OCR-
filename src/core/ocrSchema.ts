import { z } from "zod";

// Claude に返させる構造化 JSON のスキーマ。
// 画面に写っていない項目は null / 空配列で返させ、推測で埋めさせない。

// 共有インスタンスを使い回すと JSON Schema 化の際に $ref となり説明文が落ちるため、毎回生成する
const nullableString = (description?: string) => {
  const s = z.string().nullable();
  return description ? s.describe(description) : s;
};
const nullableNumber = (description?: string) => {
  const s = z.number().nullable();
  return description ? s.describe(description) : s;
};

const statSchema = () =>
  z.object({
    base: nullableNumber("基礎値 (数値)"),
    growth: nullableString('成長率 (例: "+2.6")'),
  });

export const OcrExtractionSchema = z.object({
  screen_types: z
    .array(z.string())
    .describe("写っている画面の種類 (基本情報 / スキル / 覚醒 / 天賦 / 連携 / 兵種 など)"),
  name: nullableString("画面に表示された武将名をそのまま (接頭辞・【特】も含めてよい)"),
  title_alias: nullableString("二つ名"),
  rarity: nullableString("SSR / SR / R / N / SP"),
  faction: nullableString("勢力"),
  level: nullableNumber(),
  stars: nullableNumber("星の数 0〜5"),

  special_marker_visible: z.boolean().describe("画面に【特】の表記が実際に写っている場合のみ true"),

  growth_total: nullableString('成長値合計 (例: "9" や "8.5")'),
  attack: statSchema(),
  defense: statSchema(),
  stratagem: statSchema(),
  troops: statSchema(),

  skill: z.object({
    name: nullableString("奥義スキル名"),
    gauge: nullableNumber("必要ゲージ数 1〜3"),
    desc: nullableString("奥義スキル効果の全文"),
  }),

  awakening: z.object({
    visible: z.boolean().describe("覚醒スキルの情報が画面に写っている場合 true"),
    skill_name: nullableString("覚醒スキル名 (優先度の括弧書きは除く)"),
    priority: nullableString("覚醒スキルの発動優先度。十干と数字の組 (甲·1 / 乙·2 / … / 癸·10)。古い画面なら 極高 / 高 / 中 / 低"),
    before_weapon_effect: nullableString("通常の (武器覚醒前の) 覚醒スキル効果の全文"),
    weapon_awakening_visible: z
      .boolean()
      .describe("専用武器覚醒の表示が この画像に 実際に写っている場合のみ true"),
    after_weapon_effect: nullableString("武器覚醒後の効果の全文 (この画像に写っている場合のみ)"),
  }),

  talents: z.array(
    z.object({
      star_level: z.number().describe("星1〜星5"),
      position: z.string().describe("天賦の位置・枠 (不明なら空文字)"),
      name: z.string().describe("天賦の名前。名前が無く効果だけの場合は空文字"),
      effect: z.string().describe("効果 (例: 物理防御+50%)"),
      unlocked: z.boolean().describe("解放済み (グレーアウトしていない) なら true"),
    }),
  ),

  troop_type: nullableString("現在選択中の兵種"),
  troop_variants: z.array(z.string()).describe("選択可能な兵種一覧"),

  synergy_skills: z.array(
    z.object({
      partner: z.string().describe("この武将以外の連携相手の武将名 (複数なら「、」区切り)"),
      effect: z.string().describe("条件を含む文章の全文 (例: 〇〇、△△が同時に場内にいる場合、計略防御+20%)"),
    }),
  ),
});

export type OcrExtraction = z.infer<typeof OcrExtractionSchema>;
