// 画像の前処理 (端末内で縮小・JPEG 化してから保存・送信する)

// 解析用: 長辺 3072px まで残す (ゲーム画面の小さな文字をつぶさないため)
const ANALYSIS = { maxEdge: 3072, quality: 0.95 };
// 解析後の保存用: 図鑑で見るには十分な大きさに縮めて容量を節約する (3,000 枚でも数百 MB 程度)
const GALLERY = { maxEdge: 1280, quality: 0.82 };

async function decode(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  try {
    return await createImageBitmap(file);
  } catch {
    // 一部の形式 (HEIC 等) は <img> 経由なら読める
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/** 長辺 3072px 以内の JPEG に変換する。API の画像サイズ上限と端末の保存容量の両方に効く */
export async function compressImage(file: Blob, opts = ANALYSIS): Promise<Blob> {
  const src = await decode(file);
  const w = "naturalWidth" in src ? src.naturalWidth : src.width;
  const h = "naturalHeight" in src ? src.naturalHeight : src.height;
  if (!w || !h) throw new Error("画像を読み込めませんでした");
  const scale = Math.min(1, opts.maxEdge / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画像を処理できませんでした");
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  if ("close" in src) src.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", opts.quality));
  canvas.width = canvas.height = 0; // iOS のキャンバスメモリを早めに解放
  if (!blob) throw new Error("画像を変換できませんでした");
  return blob;
}

/** 解析が終わった画像を保存用の大きさに縮める */
export const shrinkForGallery = (blob: Blob) => compressImage(blob, GALLERY);

export function blobToBase64(blob: Blob): Promise<string> {
  return blobToDataUrl(blob).then((url) => url.slice(url.indexOf(",") + 1));
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  return (await fetch(dataUrl)).blob();
}

/** 画面の左側 (武将の立ち絵がある所) だけを切り出す。立ち絵の見比べに使うので小さくてよい */
export async function cropLeft(blob: Blob, ratio = 0.45, maxEdge = 640): Promise<Blob> {
  const src = await decode(blob);
  const w = "naturalWidth" in src ? src.naturalWidth : src.width;
  const h = "naturalHeight" in src ? src.naturalHeight : src.height;
  if (!w || !h) throw new Error("画像を読み込めませんでした");
  const cw = Math.round(w * ratio);
  const scale = Math.min(1, maxEdge / Math.max(cw, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(cw * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画像を処理できませんでした");
  ctx.drawImage(src, 0, 0, cw, h, 0, 0, canvas.width, canvas.height);
  if ("close" in src) src.close();
  const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  canvas.width = canvas.height = 0;
  if (!out) throw new Error("画像を変換できませんでした");
  return out;
}
