// 画像の前処理 (端末内で縮小・JPEG 化してから保存・送信する)

// 長辺 3072px まで残す (ゲーム画面の小さな文字をつぶさないため)
const MAX_EDGE = 3072;

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
export async function compressImage(file: Blob): Promise<Blob> {
  const src = await decode(file);
  const w = "naturalWidth" in src ? src.naturalWidth : src.width;
  const h = "naturalHeight" in src ? src.naturalHeight : src.height;
  if (!w || !h) throw new Error("画像を読み込めませんでした");
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画像を処理できませんでした");
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  if ("close" in src) src.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.95));
  canvas.width = canvas.height = 0; // iOS のキャンバスメモリを早めに解放
  if (!blob) throw new Error("画像を変換できませんでした");
  return blob;
}

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
