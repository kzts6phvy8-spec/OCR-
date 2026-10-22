import type { Warlord } from "../../core/types.ts";
import type { VisualMatcher } from "../../core/ingest.ts";
import * as db from "./db.ts";
import { blobToBase64, cropLeft } from "./images.ts";
import { loadSettings, type Settings } from "./settings.ts";

// 【特】表記が写っていない画面を、通常武将と特異武将のどちらの画像か、画面左側の立ち絵で見分ける。
// 同じ名前の特異武将が登録済みの時だけ、AI に 1 回だけ追加で尋ねる (無料枠の回数を 1 回使う)。

const LETTERS = ["A", "B", "C"];
/** 1 人あたりの見本の枚数 (代表画像 + もう 1 枚) */
const SAMPLES = 2;

const PROMPT = (labels: string[]) =>
  [
    "スマホゲーム『戦国布武』の武将画面のスクリーンショットから、画面左側の武将の立ち絵 (キャラクターのイラスト) だけを切り出した画像です。",
    "同じ武将名でも、通常武将と特異武将は立ち絵 (衣装・髪型・色・ポーズ・背景) が違います。文字は無視し、立ち絵の見た目だけで比べてください。",
    "",
    ...labels,
    "",
    "最後の「判定する画像」の立ち絵は、どの見本と同じ立ち絵ですか。",
    `次のどれか 1 つだけを答えてください: ${LETTERS.slice(0, labels.length).join(" / ")} / none (立ち絵はあるが、どの見本とも違う) / unknown (立ち絵が写っていない・判断できない)`,
  ].join("\n");

async function samplesOf(w: Warlord): Promise<string[]> {
  const ids = [...new Set([w.image_url, ...w.gallery_images].filter(Boolean))].slice(0, SAMPLES);
  const out: string[] = [];
  for (const id of ids) {
    const blob = await db.getImage(id);
    if (blob) out.push(await blobToBase64(await cropLeft(blob)));
  }
  return out;
}

type Part = { text: string } | { image: string };

async function ask(parts: Part[], settings: Settings): Promise<string> {
  if (settings.provider === "claude") {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true, timeout: 45_000, maxRetries: 1 });
    const res = await client.messages.create({
      model: settings.model,
      max_tokens: 50,
      messages: [
        {
          role: "user",
          content: parts.map((p) =>
            "text" in p
              ? { type: "text" as const, text: p.text }
              : { type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: p.image } },
          ),
        },
      ],
    });
    return res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  }
  const { GoogleGenAI } = await import("@google/genai");
  const client = new GoogleGenAI({ apiKey: settings.geminiKey, httpOptions: { timeout: 45_000 } });
  const res = await client.models.generateContent({
    model: settings.geminiModel,
    contents: [{ role: "user", parts: parts.map((p) => ("text" in p ? { text: p.text } : { inlineData: { mimeType: "image/jpeg", data: p.image } })) }],
    config: { temperature: 0 },
  });
  return res.text ?? "";
}

/** 判定する画像 (端末内の画像 ID) ごとに、立ち絵で見分ける関数を作る */
export function visualMatcher(imageId: string): VisualMatcher {
  return async (candidates) => {
    const settings = loadSettings();
    const target = await db.getImage(imageId);
    if (!target) return null;
    const parts: Part[] = [];
    const labels: string[] = [];
    const used: Warlord[] = [];
    for (const w of candidates.slice(0, LETTERS.length)) {
      const samples = await samplesOf(w);
      if (samples.length === 0) continue;
      const letter = LETTERS[used.length];
      used.push(w);
      labels.push(`見本 ${letter}: ${w.is_special ? "特異武将" : "通常武将"}「${w.name}」の立ち絵 (${samples.length} 枚)`);
      parts.push({ text: `見本 ${letter} (${w.is_special ? "特異武将" : "通常武将"}):` }, ...samples.map((image) => ({ image })));
    }
    if (used.length === 0) return null;
    parts.unshift({ text: PROMPT(labels) });
    parts.push({ text: "判定する画像:" }, { image: await blobToBase64(await cropLeft(target)) });

    const answer = (await ask(parts, settings)).trim().toUpperCase();
    if (/UNKNOWN/.test(answer)) return null;
    if (/NONE/.test(answer)) return "none";
    const letter = answer.match(/\b([A-C])\b/)?.[1] ?? answer.match(/^([A-C])/)?.[1];
    const idx = letter ? LETTERS.indexOf(letter) : -1;
    return used[idx]?.id ?? null;
  };
}
