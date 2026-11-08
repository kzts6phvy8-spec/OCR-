import type { Warlord } from "../../core/types.ts";
import * as db from "./db.ts";
import { blobToBase64, compressImage } from "./images.ts";
import { OcrError } from "./ocrCommon.ts";
import { loadSettings } from "./settings.ts";
import { ask, type Part } from "./visual.ts";

// 同じ勢力に同じ名前の武将が何人もいて、名将一覧の名前だけでは決められない時に、AI に登録画像を見せて名将かどうかを確かめる。
// 名将の武将は、スキル画面の奥義スキル名の行の右端に青い「名将一覧」のボタンがある。AI の問い合わせは武将 1 人につき 1 回。

const PROMPT = (n: number) =>
  [
    `スマホゲーム『戦国布武』の、1 人の武将のスクリーンショットが ${n} 枚あります。`,
    "スキル画面 (奥義スキルの名前と効果が書かれた欄がある画面) が写っている画像があるかを skill_visible に答えてください。",
    "その奥義スキル名の行の右端に、青い「名将一覧」のボタンがあれば meisho を true にしてください。",
    "覚醒スキルの行の右端にある「専用武器覚醒」のボタンは「名将一覧」ではありません。",
    "「名将修行」の画面 (少史 >> 大史 >> 少納言 … と並ぶ画面) が写っていれば、skill_visible と meisho を true にしてください。",
  ].join("\n");

const SCHEMA = {
  type: "object",
  properties: { skill_visible: { type: "boolean" }, meisho: { type: "boolean" } },
  required: ["skill_visible", "meisho"],
};

/** 武将の登録画像から、名将かどうかを AI に確かめる (スキル画面が無ければ null = 分からない) */
export async function checkMeishoWithAi(w: Warlord): Promise<boolean | null> {
  const parts: Part[] = [];
  let n = 0;
  for (const id of w.gallery_images.slice(0, 6)) {
    const blob = await db.getImage(id);
    if (!blob) continue;
    n++;
    parts.push({ text: `画像 ${n}:` }, { image: await blobToBase64(await compressImage(blob, { maxEdge: 1600, quality: 0.85 })) });
  }
  if (n === 0) return null;
  parts.unshift({ text: PROMPT(n) });
  const text = await ask(parts, loadSettings(), SCHEMA, 100);
  let parsed: { skill_visible?: boolean; meisho?: boolean };
  try {
    parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    throw new OcrError("AI の答えを読み取れませんでした", true, 3_000);
  }
  if (parsed.meisho) return true;
  return parsed.skill_visible ? false : null;
}
