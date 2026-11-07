import { describe, expect, it } from "vitest";
import { crc32, splitForZip, zipParts } from "./zip.ts";

describe("ZIP", () => {
  it("CRC32 が正しい", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
  it("ZIP を作れる", async () => {
    const parts = zipParts([
      { name: "織田信長.jpg", data: new Blob([new Uint8Array([1, 2, 3])]), crc: crc32(new Uint8Array([1, 2, 3])) },
      { name: "【特】織田信長.jpg", data: new Blob([new Uint8Array([4, 5])]), crc: crc32(new Uint8Array([4, 5])) },
    ]);
    const buf = new Uint8Array(await new Blob(parts).arrayBuffer());
    expect(new DataView(buf.buffer).getUint32(0, true)).toBe(0x04034b50);
    if (process.env.ZIP_OUT) (await import("node:fs")).writeFileSync(process.env.ZIP_OUT, buf);
  });
});

describe("ZIP を大きさで分ける", () => {
  it("1 つが上限を超えないように分け、全部の中身が入る", async () => {
    const entries = Array.from({ length: 10 }, (_, i) => {
      const data = new Uint8Array(400).fill(i);
      return { name: `武将${i}.jpg`, data: new Blob([data]), crc: crc32(data) };
    });
    const groups = splitForZip(entries, 1500);
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.flat()).toHaveLength(10);
    for (const g of groups) expect(new Blob(zipParts(g)).size).toBeLessThanOrEqual(1500);
  });
});
