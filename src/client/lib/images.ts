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

/**
 * 立ち絵の「指紋」: 画面左側を 16×32 の色の並びに縮めたもの。
 * 同じ立ち絵なら画面が違ってもほぼ同じ並びになるので、AI に尋ねる前に端末だけで見比べられる。
 */
export async function artSignature(blob: Blob): Promise<Float32Array> {
  const W = 16;
  const H = 32;
  const src = await decode(blob);
  const w = "naturalWidth" in src ? src.naturalWidth : src.width;
  const h = "naturalHeight" in src ? src.naturalHeight : src.height;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx || !w || !h) throw new Error("画像を処理できませんでした");
  ctx.drawImage(src, 0, Math.round(h * 0.1), Math.round(w * 0.45), Math.round(h * 0.85), 0, 0, W, H);
  if ("close" in src) src.close();
  const data = ctx.getImageData(0, 0, W, H).data;
  const out = new Float32Array(W * H * 3);
  for (let i = 0, j = 0; i < data.length; i += 4) {
    out[j++] = data[i];
    out[j++] = data[i + 1];
    out[j++] = data[i + 2];
  }
  return out;
}

/** 2 つの指紋の似ている度合い (正規化相互相関、1 に近いほど同じ) */
export function signatureSimilarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}
