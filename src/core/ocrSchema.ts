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
  faction: nullableString("勢力 (奥.関.甲 / 東海 / 畿内 / 中.九 / 姫武将 / 限定武将 / 鬼憑武将 / 旧時代 / 頂点武将 / 物語武将 / コラボ武将 のどれか)"),
  level: nullableNumber(),
  stars: nullableNumber("星の数 0〜5"),

  special_marker_visible: z.boolean().describe("画面に【特】の表記が実際に写っている場合のみ true"),
  // 前の版で送った解析 (サーバーで待っている分) の結果には無いので、無くても通す
  // 名将修行の画面。前の版で送った解析 (サーバーで待っている分) の結果には無いので、無くても通す
  meisho_training: z
    .object({
      visible: z.boolean().describe("「名将修行」の画面が写っている場合のみ true"),
      selected_rank: nullableString("光って選ばれている丸の段階: 少史 / 大史 / 少納言 / 大輔 / 中納言 のどれか"),
      selected_slot: nullableString("選ばれている丸がその段階の 上 か 下 か (丸が 1 つだけの段階なら null)"),
      effect: nullableString("「追加天賦」の欄の効果と数値 (例: 兵数上限+175)。「(未修行)」は含めない"),
      trained: z.boolean().describe("「追加天賦」の欄に「(未修行)」と書かれていなければ true"),
    })
    .optional(),
  // 頂点武将の「突破」の画面 (頂天突破)。前の版で送った解析の結果には無いので、無くても通す
  apex_breakthrough: z
    .object({
      visible: z.boolean().describe("頂点武将の「突破」の画面 (紫の星空に丸が線でつながった図があり、下に効果の欄と緑の「突破」ボタンがある画面) が写っている場合のみ true"),
      selected_area: nullableString("光って (黄色い輪で) 選ばれている丸がある場所: 左上 / 右上 / 中央 / 右下 / 左下 のどれか"),
      selected_size: nullableString("選ばれている丸が 大きい丸 なら 大、小さい丸 なら 小"),
      title: nullableString("下の欄のオレンジ色の見出しをそのまま (例: 追加天賦 / 突破スキル(辛·8) / 受動スキル / 【強化】受動スキル / 【強化】突破スキル(庚·7) / 固有の名前)"),
      effect: nullableString("見出しの下の効果の全文。「(未突破)」と、「強化後、…上書きされ…」の注意書きは含めない"),
      cost: nullableNumber("緑の「突破」ボタンの数字 (例: 25)。ボタンが無ければ null"),
    })
    .optional(),
  passive_skill: z
    .object({
      visible: z.boolean().describe("スキル画面に「受動スキル」の欄が写っている場合のみ true (頂点武将だけにある)"),
      desc: nullableString("「受動スキル」の欄の効果の全文"),
    })
    .optional(),
  meisho_marker_visible: z.boolean().optional().describe("奥義スキル名の行の右端に青い「名将一覧」のボタンが写っている、または「名将修行」の画面の場合のみ true"),

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
      star_level: z.number().describe("星1〜星5 (1 段目の左が星1・右が星2、2 段目の左が星3・右が星4、3 段目が星5)"),
      position: z.string().describe("画面の位置: 1段目左 / 1段目右 / 2段目左 / 2段目右 / 3段目 のどれか。「星一解放:…」と書かれた一覧なら、その「星一解放」〜「星五解放」"),
      name: z.string().describe("常に空文字 (「固守」「気勢」などの天賦の名前は書かない)"),
      effect: z.string().describe("効果と数値だけ (例: 物理防御+30%、奥義ゲージ+1)"),
      unlocked: z.boolean().describe("解放済み (グレーアウトしていない) なら true"),
    }),
  ),

  troop_type: nullableString("使わない。常に null"),
  troop_variants: z.array(z.string()).describe("選択可能な兵種一覧"),

  synergy_skills: z.array(
    z.object({
      partner: z.string().describe("この武将以外の連携相手の武将名 (複数なら「、」区切り)"),
      effect: z.string().describe("条件を含む文章の全文 (例: 〇〇、△△が同時に場内にいる場合、計略防御+20%)"),
    }),
  ).describe("連携スキルの一覧。文字が薄い・灰色の (まだ発動していない) 行も含めて、見えている行をすべて"),
});

export type OcrExtraction = z.infer<typeof OcrExtractionSchema>;

/**
 * 読み取り結果の食い違いを直す。頂天突破の画面も下に「追加天賦」の欄があるので、
 * AI が名将修行の画面とも答えることがある: 頂天突破の画面なら名将修行の画面ではない
 */
export function tidyExtraction(e: OcrExtraction): OcrExtraction {
  if (e.apex_breakthrough?.visible && e.meisho_training?.visible) {
    return { ...e, meisho_training: { ...e.meisho_training, visible: false }, meisho_marker_visible: false };
  }
  return e;
}
