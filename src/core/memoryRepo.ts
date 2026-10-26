import type { Warlord, WarlordInput } from "./types.ts";
import type { WarlordRepo } from "./ingest.ts";

/** テスト用のメモリ上の保存先 */
export function createMemoryRepo(): WarlordRepo & { all(): Warlord[] } {
  const rows = new Map<string, Warlord>();
  let seq = 0;
  const wrap = (id: string, input: WarlordInput, created_at: string): Warlord => ({
    ...structuredClone(input),
    id,
    screenshot_count: input.gallery_images.length,
    created_at,
    updated_at: new Date().toISOString(),
  });
  return {
    async get(id) {
      return rows.get(id) ?? null;
    },
    async findByName(name) {
      return [...rows.values()].filter((w) => w.name === name);
    },
    async insert(input) {
      const w = wrap(`w${++seq}`, input, new Date().toISOString());
      rows.set(w.id, w);
      return w;
    },
    async update(id, input) {
      const w = wrap(id, input, rows.get(id)!.created_at);
      rows.set(id, w);
      return w;
    },
    all: () => [...rows.values()],
  };
}
