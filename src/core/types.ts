// アプリ全体で使う型定義 (データはすべて端末内の IndexedDB に保存する)

import type { OcrExtraction } from "./ocrSchema.ts";

export const RARITIES = ["SSR", "SR", "R", "N", "SP"] as const;
export type Rarity = (typeof RARITIES)[number];

export const FACTIONS = [
  "奥.関.甲",
  "東海",
  "畿内",
  "中.九",
  "姫武将",
  "限定武将",
  "鬼憑武将",
  "旧時代",
  "頂点武将",
  "物語武将",
  "コラボ武将",
] as const;
export type Faction = (typeof FACTIONS)[number];

/** 覚醒・突破スキルの発動優先度の十干 (甲 が最も早い)。数字は十干の順番と同じ (甲・1 〜 癸・10) */
export const PRIORITY_STEMS = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"] as const;
/** 発動優先度 (ゲームのアップデート後の表記)。「甲・1」〜「癸・10」 */
export const AWAKENING_PRIORITIES = PRIORITY_STEMS.map((s, i) => `${s}・${i + 1}`);
/** アップデート前の表記。保存済みのデータのためだけに残す */
export const LEGACY_AWAKENING_PRIORITIES = ["極高", "高", "中", "低"] as const;

export interface Talent {
  star_level: number;
  position: string;
  name: string;
  effect: string;
  unlocked: boolean;
}

/** 名将修行の段階 (左から順に進む) */
export const MEISHO_RANKS = ["少史", "大史", "少納言", "大輔", "中納言"] as const;
/** 名将修行の丸 8 つ (少史・少納言・中納言は上下 2 つ、大史・大輔は 1 つ) */
export const MEISHO_SLOTS: { rank: string; slot: string }[] = [
  { rank: "少史", slot: "上" },
  { rank: "少史", slot: "下" },
  { rank: "大史", slot: "" },
  { rank: "少納言", slot: "上" },
  { rank: "少納言", slot: "下" },
  { rank: "大輔", slot: "" },
  { rank: "中納言", slot: "上" },
  { rank: "中納言", slot: "下" },
];

/**
 * 名将修行の追加天賦 1 つ。修行の画面は 少史 >> 大史 >> 少納言 >> 大輔 >> 中納言 と並び、
 * 少史・少納言・中納言は上下 2 つ、大史・大輔は 1 つの丸がある。丸を選ぶと下の「追加天賦」に効果が出る
 */
export interface MeishoTalent {
  /** 段階 (少史 / 大史 / 少納言 / 大輔 / 中納言) */
  rank: string;
  /** 段階の中の位置 (上 / 下。1 つだけの段階は空) */
  slot: string;
  /** 効果と数値 (例: 兵数上限+175) */
  effect: string;
  /** 修行済みか (「(未修行)」と書かれていなければ修行済み) */
  trained: boolean;
}

export interface SynergySkill {
  partner: string;
  effect: string;
}

export interface Warlord {
  id: string;
  name: string;
  is_special: boolean;
  title_alias: string;
  rarity: Rarity | "";
  faction: Faction | "";
  level: number;
  stars: number;

  growth_total: string;
  attack_base: number;
  attack_growth: string;
  defense_base: number;
  defense_growth: string;
  stratagem_base: number;
  stratagem_growth: string;
  troops_base: number;
  troops_growth: string;

  skill_name: string;
  skill_gauge: number;
  skill_desc: string;

  has_awakening: boolean;
  awakening_skill_name: string;
  awakening_priority: string;
  has_weapon_awakening: boolean;
  awakening_before_weapon: string;
  awakening_after_weapon: string;

  talents: Talent[];

  troop_type: string;
  troop_variants: string[];

  synergy_skills: SynergySkill[];
  /** この武将には連携スキルが無い (手で付ける印。「未入力: 連携スキル」に出さない) */
  no_synergy?: boolean;
  /** 名将機能が開放された武将 (奥義スキルの欄の右上に「名将一覧」がある)。読み取りで見つかるほか、手でも付けられる */
  is_meisho?: boolean;
  /** 名将かどうかを手で決めた (自動の判断で付けたり外したりしない) */
  meisho_manual?: boolean;
  /** 名将修行の追加天賦 (名将修行の画面から読み取る) */
  meisho_talents?: MeishoTalent[];
  /** 名将修行の画面の画像 (登録画像とは別に持つ。同じ武将の名将修行の画面を見分ける手がかり・見分け直しに使う) */
  meisho_images?: string[];
  /** 名将修行の画面を、利用者が手でこの武将に振り分けたことがある (この武将も名将修行の画面の見分けの候補にする) */
  meisho_training_manual?: boolean;
  /** 書き出しの時だけ付ける: 名将修行の追加天賦が、シミュレーターに直接渡したデータから入っている (図鑑には保存しない) */
  meisho_source?: "simulator";
  /** 鬼憑武将のシーズン (4 人の組。例: 徳川四天王)。連携スキルから自動で入るほか、手でも選べる */
  oni_season?: string;
  /** 天賦の星の番号を、画面の並び (①② / ③④ / ⑤) に合わせて直し済みか */
  talent_order_v2?: boolean;
  /** 前の版の並べ替えを元に戻し済みか */
  talent_reorder_undone?: boolean;
  /** 天賦の並びの自動判断の見直し (左右逆の読み取りと取り違えないように) を済ませたか */
  talent_check_v2?: boolean;
  /** 天賦を AI で画面の位置から読み直し済みか (法則に当てはまらなくても、それは本当にそういう武将) */
  talent_ai_read?: boolean;
  /** 最後に「再解析」で読み取った内容を作り直した回 (同じ回の 2 枚目以降で消し直さないため) */
  reset_batch?: string;

  /** 代表画像の ID (端末内の画像ストア) */
  image_url: string;
  /** 統合された元画像の ID 一覧 */
  gallery_images: string[];
  screenshot_count: number;
  created_at: string;
  updated_at: string;
}

/** 手動作成・編集で受け付ける項目 (メタデータ以外) */
export type WarlordInput = Omit<
  Warlord,
  "id" | "created_at" | "updated_at" | "screenshot_count"
>;

export type UploadMode = "auto" | "force_normal" | "force_special";

/** queued: 待機中 / processing: 解析中 (サーバーへ送信中も含む) / remote: サーバーで解析待ち / done / error */
export type JobStatus = "queued" | "processing" | "remote" | "done" | "error";

/** まだ結果が出ていないジョブか */
export const isPending = (s: JobStatus) => s === "queued" || s === "processing" || s === "remote";

export interface OcrJob {
  id: string;
  file_name: string;
  image_id: string;
  mode: UploadMode;
  /** アップロード時に選んだ勢力 (空なら AI の読み取り結果を使う) */
  faction: Faction | "";
  target_id: string | null;
  status: JobStatus;
  error: string | null;
  /** 処理結果: 登録/統合された武将 */
  warlord_id: string | null;
  warlord_label: string | null;
  merged: boolean;
  warnings: string[];
  attempts: number;
  /** 解析を始めた時刻 (残り時間の目安に使う) */
  started_at?: string | null;
  /** バックグラウンド解析がオンでも、この端末で直接解析する (サーバーで止まった分の引き取り) */
  local?: boolean;
  /** 読み取りは済んだが保存の途中で止まった時の読み取り結果 (やり直す時に読み取りを繰り返さない) */
  extraction?: OcrExtraction | null;
  /** 登録済みの画像の再解析・作り直し (失敗したジョブを消しても画像は残す) */
  keep_image?: boolean;
  /** この武将たちには統合しない (立ち絵ごとに分ける時、元の武将に戻らないように) */
  exclude_ids?: string[];
  /** 統合先が新しく作ったばかりの武将: 通常/特異は画像の読み取り結果に合わせる */
  adopt_special?: boolean;
  /** 天賦だけを読み直す (統合先の天賦を置き換える) */
  talents_only?: boolean;
  /** 名将修行の画面の見分けをサーバーに任せている段階 (1: 一覧表から候補を選ぶ / 2: 候補から 1 人に決める) */
  meisho_stage?: number | null;
  /** 見分けの依頼に並べた武将の ID (答えの番号を武将に戻すため) */
  meisho_ids?: string[] | null;
  /** サーバーに尋ねた立ち絵の確認の答え (武将 ID → 同じ/違う/分からない。厳しめに判定したものは ID の後ろに !) */
  art_answers?: Record<string, "same" | "different" | "unknown"> | null;
  /** サーバーに立ち絵の確認を尋ねて、答えを待っている武将 (art_answers と同じ書き方) */
  art_pending?: string | null;
  /** サーバーに預けた見分け・立ち絵の確認の依頼の名前 (古い依頼の答えを取り違えないように、これと合う答えだけ使う) */
  server_req?: string | null;
  /** 「再解析」の回。この回の最初の保存の前に、統合先の読み取った内容を空にする */
  reset_batch?: string;
  created_at: string;
  updated_at: string;
}

export interface ExportPayload {
  app: "sengoku-fubu-warlord-db";
  version: 2;
  exported_at: string;
  warlords: Warlord[];
  /** 画像込みでバックアップした場合のみ: 画像 ID → data URL */
  images?: Record<string, string>;
}
