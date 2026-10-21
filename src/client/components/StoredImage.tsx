import { useEffect, useRef, useState, type ImgHTMLAttributes } from "react";
import { getImage } from "../lib/db.ts";

// 端末内に保存した画像 (ID) を表示する。画面に近づいた時だけ読み込み、読み込んだ URL は使い回す。
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
  const [visible, setVisible] = useState(false);
  const holder = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = holder.current;
    if (!el || visible) return;
    if (typeof IntersectionObserver === "undefined") return setVisible(true);
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    let alive = true;
    setSrc(null);
    if (id && visible) void loadUrl(id).then((url) => alive && setSrc(url));
    return () => {
      alive = false;
    };
  }, [id, visible]);

  if (!src) return <div ref={holder} className={`${rest.className ?? ""} bg-ebony-800`} />;
  return <img src={src} {...rest} />;
}
