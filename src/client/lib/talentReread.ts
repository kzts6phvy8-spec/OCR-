import type { Talent, Warlord } from "../../core/types.ts";
import { starFromPosition, talentEffect } from "../../core/domain.ts";
import * as db from "./db.ts";
import { blobToBase64, compressImage } from "./images.ts";
import { OcrError } from "./ocrCommon.ts";
import { loadSettings } from "./settings.ts";
import { ask, type Part } from "./visual.ts";

// 天賦だけを読み直す。武将の登録画像をまとめて AI に見せ、天賦が写っている画面から、天賦ごとの「画面の位置」と効果を答えさせる。
// 星の番号は位置からアプリが決める (AI が振る番号は、画像によって振り方が違ったため)。AI の問い合わせは武将 1 人につき 1 回。

const PROMPT = (n: number) =>
  [
    `スマホゲーム『戦国布武』の、1 人の武将のスクリーンショットが ${n} 枚あります。`,
    "このうち天賦が写っている画像を見つけ、5 つの天賦をすべて答えてください。",
    "天賦の画面は ①② / ③④ / ⑤ の 3 段に並んでいます。それぞれの天賦が画面のどこにあるかを position に「1段目左」「1段目右」「2段目左」「2段目右」「3段目」のどれかで書いてください。",
    "装備の画面のように「星一解放:計略防御+80%」と縦に並んでいる時は、position にその行の「星一解放」〜「星五解放」をそのまま書いてください。",
    "effect には「何が何%上がるか」の効果と数値だけを書いてください (例: 計略攻撃+30%)。「鬼謀」「会心」のような天賦の名前は書かないでください。",
    "鍵マーク・グレーアウトなど未解放なら unlocked を false にしてください。天賦が写っている画像が無ければ found を false にしてください。",
  ].join("\n");

const SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean" },
    talents: {
      type: "array",
      items: {
        type: "object",
        properties: { position: { type: "string" }, effect: { type: "string" }, unlocked: { type: "boolean" } },
        required: ["position", "effect", "unlocked"],
      },
    },
  },
  required: ["found", "talents"],
};

/** AI に見せる画像を選ぶ: 読み取り結果に天賦がある画像 (天賦・装備の画面) を先に。分からなければ登録画像を順に (最大 6 枚) */
async function pickImages(w: Warlord): Promise<string[]> {
  const ids = [...new Set([...w.gallery_images, w.image_url].filter(Boolean))];
  const withTalents: string[] = [];
  for (const id of ids) {
    const ext = await db.getExtraction(id).catch(() => null);
    if (ext && (ext.talents.length > 0 || ext.screen_types.some((t) => /天賦|装備/.test(t)))) withTalents.push(id);
  }
  return (withTalents.length ? withTalents : ids).slice(0, 6);
}

/** 天賦を読み直す依頼 (AI に見せる文章と画像) を作る */
export async function buildTalentRequest(w: Warlord): Promise<Part[]> {
  const parts: Part[] = [];
  let n = 0;
  for (const id of await pickImages(w)) {
    const blob = await db.getImage(id);
    if (!blob) continue;
    n++;
    parts.push({ text: `画像 ${n}:` }, { image: await blobToBase64(await compressImage(blob, { maxEdge: 2048, quality: 0.9 })) });
  }
  if (n === 0) throw new OcrError("画像がありません", false);
  parts.unshift({ text: PROMPT(n) });
  return parts;
}

export const TALENT_SCHEMA = SCHEMA;
/** AI の答えの長さの上限 */
export const TALENT_MAX_TOKENS = 4096;

/** AI の答えから天賦を取り出す (星の番号は位置から決める) */
export function parseTalentAnswer(text: string): Talent[] {
  let parsed: { found?: boolean; talents?: { position?: string; effect?: string; unlocked?: boolean }[] };
  try {
    parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    throw new OcrError("AI の答えを読み取れませんでした", true, 3_000);
  }
  if (!parsed.found || !parsed.talents?.length) throw new OcrError("天賦が写っている画像がありません。天賦の画面のスクショを足してください", false);
  const byStar = new Map<number, Talent>();
  for (const t of parsed.talents) {
    const star = starFromPosition(String(t.position ?? ""));
    const effect = talentEffect(String(t.effect ?? ""));
    if (!star || !effect || byStar.has(star)) continue;
    byStar.set(star, { star_level: star, position: "", name: "", effect, unlocked: t.unlocked !== false });
  }
  if (byStar.size === 0) throw new OcrError("天賦の位置を読み取れませんでした", true, 3_000);
  return [...byStar.values()].sort((a, b) => a.star_level - b.star_level);
}

/** 武将の天賦を、この端末から AI に読み直させる */
export async function rereadTalents(w: Warlord): Promise<Talent[]> {
  const parts = await buildTalentRequest(w);
  return parseTalentAnswer(await ask(parts, loadSettings(), SCHEMA, TALENT_MAX_TOKENS));
}
