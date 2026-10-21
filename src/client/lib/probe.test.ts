import { describe, expect, it } from "vitest";
import type { OcrJob } from "../../core/types.ts";
import { STALL_MS, isStalled } from "./probe.ts";

const job = (status: OcrJob["status"], minutesAgo: number): OcrJob =>
  ({ id: Math.random().toString(), status, updated_at: new Date(Date.now() - minutesAgo * 60_000).toISOString() }) as OcrJob;

describe("isStalled", () => {
  it("サーバーで解析待ちが無ければ止まっていない", () => {
    expect(isStalled([job("done", 60)], 0)).toBe(false);
  });
  it("送ってから 10 分以上、何も反映されていなければ止まっている", () => {
    expect(isStalled([job("remote", 15)], 0)).toBe(true);
    expect(isStalled([job("remote", 5)], 0)).toBe(false);
  });
  it("最近ほかの写真の結果が反映されていれば、進んでいるとみなす", () => {
    expect(isStalled([job("remote", 30), job("done", 2)], 0)).toBe(false);
    expect(isStalled([job("remote", 30)], Date.now() - STALL_MS / 2)).toBe(false);
  });
});
