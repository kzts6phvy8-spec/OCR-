import { describe, expect, it } from "vitest";
import { interpretAnswer } from "./visual.ts";

describe("立ち絵の見比べの答え", () => {
  it("確信の無い「違う」は同じとみなす", () => {
    expect(interpretAnswer('{"art_visible":true,"same":true,"confidence":60}')).toBe("same");
    expect(interpretAnswer('{"art_visible":true,"same":false,"confidence":95}')).toBe("different");
    expect(interpretAnswer('{"art_visible":true,"same":false,"confidence":50}')).toBe("same");
    expect(interpretAnswer('{"art_visible":false,"same":false,"confidence":90}')).toBe("unknown");
    expect(interpretAnswer('```json\n{"art_visible":true,"same":true,"confidence":90}\n```')).toBe("same");
    expect(interpretAnswer("DIFFERENT")).toBe("unknown");
    expect(interpretAnswer("")).toBe("unknown");
    // 通常・特異の 2 人と見比べる時は、確信が無くても「違う」は違う
    expect(interpretAnswer('{"art_visible":true,"same":false,"confidence":50}', true)).toBe("different");
  });
});
