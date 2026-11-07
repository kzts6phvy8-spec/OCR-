import { describe, expect, it } from "vitest";
import { crc32, zipParts } from "./zip.ts";

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
