// 画像をまとめた ZIP ファイルを作る (圧縮なし。JPEG はもともと圧縮済みなので縮まない)。
// 部品を Blob のまま並べるので、大きくなっても端末のメモリを食いにくい。

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  /** 中身 (Blob のまま渡すと、全部をメモリに読み込まずに済む) */
  data: Blob;
  /** 中身の CRC32 (crc32() で求めたもの) */
  crc: number;
}

/** ZIP の中身を、Blob にできる部品の並びとして作る */
export function zipParts(entries: ZipEntry[], date = new Date()): BlobPart[] {
  const enc = new TextEncoder();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const parts: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = e.crc;
    const size = e.data.size;
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // ファイル名は UTF-8
    lv.setUint16(8, 0, true); // 圧縮なし
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local, e.data);

    const cen = new Uint8Array(46 + name.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cen.set(name, 46);
    central.push(cen);
    offset += local.length + size;
  }
  const centralSize = central.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  return [...parts, ...central, end];
}

/** ZIP 1 つに入れた時に増える大きさ (中身 + 見出し) */
const entryBytes = (e: ZipEntry) => 30 + 46 + 2 * new TextEncoder().encode(e.name).length + e.data.size;

/**
 * 1 つの ZIP が maxBytes 以下になるように、中身を順番のまま分ける
 * (1 つだけで maxBytes を超える中身は、それだけで 1 つの ZIP にする)
 */
export function splitForZip(entries: ZipEntry[], maxBytes: number): ZipEntry[][] {
  const groups: ZipEntry[][] = [];
  let current: ZipEntry[] = [];
  let size = 22;
  for (const e of entries) {
    const add = entryBytes(e);
    if (current.length > 0 && size + add > maxBytes) {
      groups.push(current);
      current = [];
      size = 22;
    }
    current.push(e);
    size += add;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** ファイル名に使えない文字を除く */
export const safeFileName = (s: string) => s.replace(/[\\/:*?"<>|\r\n]/g, "_").trim() || "無名";
