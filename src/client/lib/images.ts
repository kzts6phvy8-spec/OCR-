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

/**
 * 解析が終わった画像を保存用の大きさに縮める。すでに保存用の大きさの JPEG はそのまま返す
 * (再解析のたびに圧縮し直して画質が落ちたり、同じ画像の中身が変わって重なりを見つけられなくなったりしないように)。
 */
export async function shrinkForGallery(blob: Blob): Promise<Blob> {
  if (blob.type === "image/jpeg") {
    try {
      const bmp = await createImageBitmap(blob);
      const fits = Math.max(bmp.width, bmp.height) <= GALLERY.maxEdge;
      bmp.close();
      if (fits) return blob;
    } catch {
      /* 大きさを測れなければ縮める */
    }
  }
  return compressImage(blob, GALLERY);
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

/** 画面の中の立ち絵の辺り (横長のゲーム画面の左寄り。上下左右の黒い余白を避ける) */
const ART_BOX = { x: 0.12, y: 0.1, w: 0.3, h: 0.8 };

/** 画面から立ち絵の辺りだけを切り出す (大きさ: 横 width px) */
export async function cropArt(blob: Blob, width = 450): Promise<Blob> {
  const src = await decode(blob);
  const w = "naturalWidth" in src ? src.naturalWidth : src.width;
  const h = "naturalHeight" in src ? src.naturalHeight : src.height;
  if (!w || !h) throw new Error("画像を読み込めませんでした");
  const sw = w * ART_BOX.w;
  const sh = h * ART_BOX.h;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.round((width * sh) / sw);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画像を処理できませんでした");
  ctx.drawImage(src, w * ART_BOX.x, h * ART_BOX.y, sw, sh, 0, 0, canvas.width, canvas.height);
  if ("close" in src) src.close();
  const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  canvas.width = canvas.height = 0;
  if (!out) throw new Error("画像を変換できませんでした");
  return out;
}

/**
 * 立ち絵の一覧表 (番号付き) を 1 枚の画像にする。AI に「この中のどれと同じ絵か」を 1 回で尋ねるため。
 * 番号は firstNumber から順に振る
 */
export async function artContactSheet(blobs: Blob[], firstNumber: number, cols = 6): Promise<Blob> {
  const CW = 150;
  const CH = 200;
  const rows = Math.ceil(blobs.length / cols);
  const canvas = document.createElement("canvas");
  canvas.width = CW * cols;
  canvas.height = CH * rows;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画像を処理できませんでした");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const [i, blob] of blobs.entries()) {
    const x = (i % cols) * CW;
    const y = Math.floor(i / cols) * CH;
    try {
      const src = await decode(blob);
      const w = "naturalWidth" in src ? src.naturalWidth : src.width;
      const h = "naturalHeight" in src ? src.naturalHeight : src.height;
      ctx.drawImage(src, w * ART_BOX.x, h * ART_BOX.y, w * ART_BOX.w, h * ART_BOX.h, x + 2, y + 2, CW - 4, CH - 4);
      if ("close" in src) src.close();
    } catch {
      /* 読めない画像は黒いまま */
    }
    // 番号 (読みやすいように白地に黒)
    const label = String(firstNumber + i);
    ctx.font = "bold 28px sans-serif";
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = "#fff";
    ctx.fillRect(x + 4, y + 4, tw + 12, 34);
    ctx.fillStyle = "#000";
    ctx.fillText(label, x + 10, y + 32);
  }
  const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  canvas.width = canvas.height = 0;
  if (!out) throw new Error("画像を変換できませんでした");
  return out;
}

/** 名将修行の画面のカードの絵 (左のカードの内側。枠・題字・下の欄を避ける) */
const TRAINING_CARD = { x: 0.17, y: 0.22, w: 0.19, h: 0.48 };

/**
 * 名将修行の画面のカードの絵の「指紋」。名将修行の画面どうしは配置が同じなので、
 * 同じ武将の画面ならほぼ同じ並びになる (どの丸を選んでいるかには左右されない)
 */
export async function trainingCardSignature(blob: Blob): Promise<Float32Array> {
  const W = 16;
  const H = 24;
  const src = await decode(blob);
  const w = "naturalWidth" in src ? src.naturalWidth : src.width;
  const h = "naturalHeight" in src ? src.naturalHeight : src.height;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx || !w || !h) throw new Error("画像を処理できませんでした");
  ctx.drawImage(src, w * TRAINING_CARD.x, h * TRAINING_CARD.y, w * TRAINING_CARD.w, h * TRAINING_CARD.h, 0, 0, W, H);
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
