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
