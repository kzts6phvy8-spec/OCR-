import { useEffect, useState, type ImgHTMLAttributes } from "react";
import { getImage } from "../lib/db.ts";

// 端末内に保存した画像 (ID) を表示する。読み込んだ URL は使い回す。
const cache = new Map<string, Promise<string | null>>();

function loadUrl(id: string) {
  let p = cache.get(id);
  if (!p) {
    p = getImage(id).then((blob) => (blob ? URL.createObjectURL(blob) : null));
    cache.set(id, p);
  }
  return p;
}

export function StoredImage({ id, ...rest }: { id: string } & Omit<ImgHTMLAttributes<HTMLImageElement>, "src">) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSrc(null);
    if (id) void loadUrl(id).then((url) => alive && setSrc(url));
    return () => {
      alive = false;
    };
  }, [id]);
  if (!src) return <div className={`${rest.className ?? ""} bg-ebony-800`} />;
  return <img src={src} {...rest} />;
}
