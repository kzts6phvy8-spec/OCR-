import { describe, expect, it } from "vitest";
import { isDailyLimit, nextDailyReset } from "./quota.ts";

describe("quota", () => {
  it("1 日の上限と 1 分の上限を見分ける", () => {
    expect(isDailyLimit("GenerateRequestsPerDayPerProjectPerModel-FreeTier")).toBe(true);
    expect(isDailyLimit("GenerateRequestsPerMinutePerProjectPerModel-FreeTier")).toBe(false);
  });
  it("上限が戻るのは太平洋時間の 0 時 (夏時間なら日本時間 16 時)", () => {
    // 2026-10-21 10:00 JST = 2026-10-20 18:00 PDT → 次の 0 時 PDT = 2026-10-21 16:00 JST
    const reset = nextDailyReset(new Date("2026-10-21T01:00:00Z"));
    expect(reset.toISOString()).toBe("2026-10-21T07:00:00.000Z");
  });
  it("冬時間なら日本時間 17 時", () => {
    const reset = nextDailyReset(new Date("2026-12-01T01:00:00Z"));
    expect(reset.toISOString()).toBe("2026-12-01T08:00:00.000Z");
  });
});
