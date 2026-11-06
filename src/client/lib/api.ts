import { AWAKENING_PRIORITIES } from "../../core/types.ts";
import type { ExportPayload, Faction, OcrJob, UploadMode, Warlord, WarlordInput } from "../../core/types.ts";
import { warlordsToText } from "../../core/text.ts";
import { decideSpecial, detectTalentOrder, emptyWarlordInput, fixColumnOrderTalents, mergeWarlord, normalizeInput, undoTalentReorder } from "../../core/domain.ts";
import { toInput } from "../../core/ingest.ts";
import { ONI_FACTION, cleanOniSynergies, shareOniSynergies } from "../../core/oni.ts";
import * as db from "./db.ts";
import { blobToDataUrl, compressImage, dataUrlToBlob, shrinkForGallery } from "./images.ts";
import * as queue from "./queue.ts";
import { findIssues, type Issue } from "../../core/health.ts";
import { getErrorLog } from "./errorLog.ts";

export interface HealthReport {
  checkedAt: string;
  /** 自動で直したもの */
  fixed: Issue[];
  /** 利用者に確かめてほしいもの */
  warnings: Issue[];
}

const HEALTH_KEY = "sengoku-fubu-health";
export function lastHealthReport(): HealthReport | null {
  try {
    return JSON.parse(localStorage.getItem(HEALTH_KEY) ?? "null") as HealthReport | null;
  } catch {
    return null;
  }
}

// 画面から使う操作。サーバーは無く、すべて端末内で完結する。

export const api = {
  warlords: () => db.listWarlords(),

  async createWarlord(input: Partial<WarlordInput>): Promise<Warlord> {
    const record = normalizeInput(input);
    if (!record.name) throw new Error("武将名は必須です");
    return db.insertWarlord(record);
  },

  /**
   * 武将を書き換える。removeImages を渡すと、その画像だけを外す
   * (画像の一覧をまるごと渡すと、編集中に解析で加わった画像まで外してしまうため)。
   */
  async updateWarlord(id: string, input: Partial<WarlordInput>, opts: { removeImages?: string[] } = {}): Promise<Warlord> {
    const current = await db.getWarlord(id);
    if (!current) throw new Error("武将が見つかりません");
    const merged = { ...toInput(current), ...input };
    if (opts.removeImages?.length) {
      const removed = new Set(opts.removeImages);
      merged.gallery_images = current.gallery_images.filter((g) => !removed.has(g));
      if (removed.has(merged.image_url)) merged.image_url = merged.gallery_images[0] ?? "";
    }
    const record = normalizeInput(merged);
    if (!record.name) throw new Error("武将名は必須です");
    const updated = await db.updateWarlord(id, record);
    await db.removeUnreferencedImages(current.gallery_images.filter((g) => !updated.gallery_images.includes(g)));
    // 鬼憑武将の連携スキルを手で入れた時も、同じ組の鬼に広める
    await shareOniSynergies(db.repo, updated);
    return updated;
  },

  /**
   * 優先度が無い・古い表記 (極高 など) の武将に、覚醒スキルの発動条件から新しい表記の優先度を入れる。
   * 起動時に呼ぶ。直した件数と、条件が一覧に無くて直せなかった件数を返す。
   */
  async fillPriorities(): Promise<{ updated: number; unmatched: number; rewritten: number }> {
    let updated = 0;
    let unmatched = 0;
    let rewritten = 0;
    for (const w of await db.listWarlords()) {
      const record = normalizeInput(toInput(w));
      if (record.awakening_priority !== w.awakening_priority) {
        await db.updateWarlord(w.id, record);
        updated++;
      } else {
        // 書き方を新しい決まりにそろえる (天賦は効果と数値だけ・「現在の兵種」は兵種の一覧へ)
        const talentsChanged = JSON.stringify(record.talents) !== JSON.stringify(w.talents);
        const troopsChanged = Boolean(w.troop_type) || JSON.stringify(record.troop_variants) !== JSON.stringify(w.troop_variants);
        const seasonChanged = (record.oni_season ?? "") !== (w.oni_season ?? "");
        if (talentsChanged || troopsChanged || seasonChanged) {
          await db.updateWarlord(w.id, record);
          rewritten++;
        }
        if (record.has_awakening && !AWAKENING_PRIORITIES.includes(record.awakening_priority)) unmatched++;
      }
    }
    return { updated, unmatched, rewritten };
  },

  /**
   * 前の版で全員の天賦にかけてしまった並べ替えを、元に戻す (起動時に呼ぶ。1 人につき 1 回だけ)。
   * 正しかった武将まで並べ替えてしまったため。戻した人数を返す
   */
  async undoTalentReorders(): Promise<number> {
    let undone = 0;
    for (const w of await db.listWarlords()) {
      if (!w.talent_order_v2 || w.talent_reorder_undone) continue;
      const input = toInput(w);
      await db.updateWarlord(
        w.id,
        normalizeInput({ ...input, talents: undoTalentReorder(w.talents), talent_order_v2: false, talent_reorder_undone: true }),
      );
      if (w.talents.length) undone++;
    }
    return undone;
  },

  /**
   * 天賦の並びのずれを、解放済み/未解放の並びから見分けて直す (AI なし・起動時に呼ぶ)。
   * 見分けられた武将には印を付け、「天賦を読み直す」の対象から外す
   */
  async autoFixTalentOrder(): Promise<{ fixed: number; unknown: number }> {
    let fixed = 0;
    let unknown = 0;
    for (const w of await db.listWarlords()) {
      if (w.talent_order_v2 || w.talents.length === 0) continue;
      const order = detectTalentOrder(w.talents);
      if (order === "unknown") {
        unknown++;
        continue;
      }
      const talents = order === "column" ? fixColumnOrderTalents(w.talents) : w.talents;
      await db.updateWarlord(w.id, normalizeInput({ ...toInput(w), talents, talent_order_v2: true }));
      if (order === "column") fixed++;
    }
    return { fixed, unknown };
  },

  /** 中身がまったく同じ画像が 2 重に登録された武将を、1 枚にまとめる (起動時に呼ぶ) */
  async dedupeImages(): Promise<{ warlords: number; images: number }> {
    const { dedupeAllImages } = await import("./dedupe.ts");
    return dedupeAllImages();
  },

  /** 特異武将として登録されてしまった姫武将を通常に戻す (姫武将は特異武将とは別物)。起動時に呼ぶ */
  async fixHimeSpecial(): Promise<number> {
    let fixed = 0;
    for (const w of await db.listWarlords()) {
      if (w.faction === "姫武将" && w.is_special) {
        await db.updateWarlord(w.id, normalizeInput({ ...toInput(w), is_special: false }));
        fixed++;
      }
    }
    return fixed;
  },

  /** 登録済みの鬼憑武将の連携スキルを整える (混ざった他の武将の連携を取り除き、同じ組の鬼に広める)。起動時に呼ぶ。書き換えた人数を返す */
  async shareAllOniSynergies(): Promise<number> {
    const changed = new Set<string>();
    for (const w of await db.listWarlords()) {
      if (w.faction !== ONI_FACTION || w.synergy_skills.length === 0) continue;
      const latest = await db.getWarlord(w.id);
      if (!latest) continue;
      // 同じ名前の通常・特異武将の連携スキルが混ざっていたら取り除く (その武将の方へ移す)
      const cleaned = await cleanOniSynergies(db.repo, latest);
      if (cleaned.removed.length) changed.add(cleaned.warlord.id);
      for (const c of await shareOniSynergies(db.repo, cleaned.warlord)) changed.add(c.id);
    }
    return changed.size;
  },

  /**
   * 図鑑データを点検し、安全に直せるものは直す。直せないものは知らせるために返す。起動時と「今すぐ点検」で呼ぶ。
   */
  async runHealthCheck(): Promise<HealthReport> {
    const report: HealthReport = { checkedAt: new Date().toISOString(), fixed: [], warnings: findIssues(await db.listWarlords()) };
    try {
      localStorage.setItem(HEALTH_KEY, JSON.stringify(report));
    } catch {
      /* 保存できなくても結果は返す */
    }
    return report;
  },

  /** 点検結果とエラーの記録を、送れる文章にする */
  async healthReportText(): Promise<string> {
    const r = lastHealthReport();
    const warlords = await db.listWarlords();
    const jobs = await db.listJobs();
    const lines = [
      "【武将図鑑 点検結果】",
      `点検: ${r ? new Date(r.checkedAt).toLocaleString("ja-JP") : "まだ"}`,
      `武将 ${warlords.length} 人 / 解析履歴 ${jobs.length} 件 (失敗 ${jobs.filter((j) => j.status === "error").length} 件)`,
      `端末: ${navigator.userAgent}`,
      "",
      "■ 確かめてほしいこと",
      ...(r?.warnings.length ? r.warnings.map((i) => `- ${i.message}`) : ["- なし"]),
      "",
      "■ 自動で直したこと",
      ...(r?.fixed.length ? r.fixed.map((i) => `- ${i.message}`) : ["- なし"]),
      "",
      "■ エラーの記録 (新しい順)",
      ...(getErrorLog().length
        ? [...getErrorLog()].reverse().map((e) => `- ${new Date(e.at).toLocaleString("ja-JP")} [${e.where}] ${e.message}`)
        : ["- なし"]),
    ];
    return lines.join("\n");
  },

  async deleteWarlord(id: string) {
    await api.deleteWarlords([id]);
  },

  async deleteWarlords(ids: string[]) {
    const images: string[] = [];
    for (const id of ids) {
      const current = await db.getWarlord(id);
      if (!current) continue;
      await db.deleteWarlord(id);
      images.push(...current.gallery_images);
    }
    await db.removeUnreferencedImages(images);
  },

  /** 武将・画像・解析履歴をすべて消す (設定と API キーは残る) */
  async deleteEverything() {
    await db.deleteEverything();
    queue.notifyQueueChange();
  },

  jobs: () => db.listJobs(),
  retryJob: (id: string) => queue.retryJob(id),
  /** 失敗したジョブを、選んだ武将に統合してやり直す */
  retryJobWithTarget: (id: string, targetId: string) => queue.retryJobs([id], targetId),
  /**
   * 失敗したジョブを、新しい武将として保存し直す (統合先に合う武将がいない時)。
   * 名前と通常/特異だけの武将を作り、そこへ統合する形で保存する (読み取り済みなら AI は使わない)。
   */
  async retryJobAsNewWarlord(id: string, name: string): Promise<Warlord> {
    const job = await db.getJob(id);
    if (!job) throw new Error("解析の記録が見つかりません");
    if (job.status !== "error") throw new Error("この解析は、すでにやり直し中か完了しています");
    const isSpecial = job.extraction ? decideSpecial(job.extraction, job.mode).is_special : job.mode === "force_special";
    const created = await db.insertWarlord(normalizeInput({ ...emptyWarlordInput(), name, is_special: isSpecial }));
    // 読み取りがまだの (送信や解析で失敗した) 画像は、読み取った【特】表記で通常/特異を決め直す
    await queue.retryJobs([id], created.id, true);
    return created;
  },
  removeJobs: (ids: string[]) => queue.removeJobs(ids),
  takeOverRemoteJobs: () => queue.takeOverRemoteJobs(),
  resendRemoteJobs: () => queue.resendRemoteJobs(),
  async retryAllFailed() {
    const failed = (await db.listJobs()).filter((j) => j.status === "error").map((j) => j.id);
    await queue.retryJobs(failed);
    return failed.length;
  },

  async clearFinishedJobs() {
    const failedImages = await db.deleteFinishedJobs();
    await db.removeUnreferencedImages(failedImages);
    queue.notifyQueueChange();
  },

  /** 画像を縮小して端末内に保存し、解析キューに追加する */
  async upload(
    files: File[],
    opts: { mode: UploadMode; targetId: string | null; faction: Faction | "" },
    onProgress: (ratio: number) => void,
  ): Promise<OcrJob[]> {
    const stored: { fileName: string; imageId: string }[] = [];
    for (const [i, file] of files.entries()) {
      const blob = await compressImage(file);
      stored.push({ fileName: file.name || `画像${i + 1}`, imageId: await db.putImage(blob) });
      onProgress((i + 1) / files.length);
    }
    return queue.enqueue(stored, opts.mode, opts.targetId, opts.faction);
  },

  /** この武将に登録済みの画像を、もう一度解析してこの武将に統合する (空欄の補完用) */
  async reanalyzeWarlord(id: string): Promise<OcrJob[]> {
    const w = await db.getWarlord(id);
    if (!w || w.gallery_images.length === 0) return [];
    // 読み取った内容は、この武将の画像だけから作り直す (今の内容に重ねると、前に混ざった別の武将の情報が残り続けるため)。
    // 消すのは、この回の最初の画像の読み取りが成功して保存する直前 (全部失敗した時に、武将が空のまま残らないように)
    const resetBatch = crypto.randomUUID();
    const images = w.gallery_images.map((imageId, i) => ({ fileName: `${w.name} の画像${i + 1} (再解析)`, imageId }));
    return queue.enqueue(images, "auto", id, "", true, { resetBatch });
  },

  /**
   * 同じ名前の武将 (通常・特異) を、登録画像から作り直す。混ざってしまった情報を立ち絵で分け直す時に使う。
   * 武将の記録だけを消し (画像は残す)、すべての画像をもう一度解析する。手で直した内容は消える。
   */
  async rebuildWarlords(name: string): Promise<{ removed: number; jobs: OcrJob[] }> {
    const targets = (await db.listWarlords()).filter((w) => w.name === name);
    // 画像の重複を除き、【特】表記のある画面が先に来やすいよう特異武将の画像を先に並べる
    const images = [...new Set(targets.sort((a, b) => Number(b.is_special) - Number(a.is_special)).flatMap((w) => w.gallery_images))];
    for (const w of targets) await db.deleteWarlord(w.id);
    const jobs = await queue.enqueue(
      images.map((imageId, i) => ({ fileName: `${name} の画像${i + 1} (作り直し)`, imageId })),
      "auto",
      null,
      "",
      true,
    );
    return { removed: targets.length, jobs };
  },

  /**
   * 別の武将として登録されてしまった武将を、この武将にまとめる (同じ武将だった時の手直し)。
   * まとめる側の空欄だけを埋め、画像は両方を残す。まとめられた側は消える。
   */
  async mergeWarlords(keepId: string, otherId: string): Promise<Warlord> {
    const keep = await db.getWarlord(keepId);
    const other = await db.getWarlord(otherId);
    if (!keep || !other) throw new Error("武将が見つかりません");
    const { name: _n, is_special: _s, ...rest } = toInput(other);
    const { merged } = mergeWarlord(toInput(keep), {
      ...rest,
      image_url: keep.image_url || other.image_url,
      gallery_images: other.gallery_images,
    });
    await db.deleteWarlord(other.id);
    const saved = await db.updateWarlord(keep.id, normalizeInput(merged));
    // まとめた側を指していた解析結果の表示も付け替える (今のジョブに重ねる。古い写しで状態を戻さないように)
    for (const job of await db.listJobs()) {
      if (job.warlord_id === other.id || job.target_id === other.id) {
        await queue.patchJob(job.id, {
          ...(job.warlord_id === other.id ? { warlord_id: keep.id } : {}),
          ...(job.target_id === other.id ? { target_id: keep.id } : {}),
        });
      }
    }
    queue.notifyQueueChange();
    return saved;
  },

  /** 画像を AI で解析せず、そのまま武将の画像に加える */
  async attachImages(id: string, files: File[]): Promise<Warlord> {
    const current = await db.getWarlord(id);
    if (!current) throw new Error("武将が見つかりません");
    const ids: string[] = [];
    for (const file of files) ids.push(await db.putImage(await shrinkForGallery(await compressImage(file))));
    return db.updateWarlord(
      id,
      normalizeInput({ ...toInput(current), gallery_images: [...current.gallery_images, ...ids], image_url: current.image_url || ids[0] || "" }),
    );
  },

  /**
   * 立ち絵が違う画像が混ざった武将を、立ち絵ごとに分ける。
   * いちばん画像の多い立ち絵をこの武将に残し (読み取った内容は、その画像だけから作り直す)、
   * 違う立ち絵の画像は、この武将以外に統合し直す (同じ立ち絵の武将がいなければ新しく登録)。
   * 読み取り結果が残っている画像は AI に読み直させない。分けた組の数を返す (分けなければ 0)。
   */
  async splitWarlord(id: string): Promise<{ groups: number; jobs: number }> {
    const w = await db.getWarlord(id);
    if (!w) throw new Error("武将が見つかりません");
    // 端末の指紋は画面の枠や背景に引っ張られて当てにならないことがあるので、AI に全部の画像を見せて組分けさせる
    const { groupByArtWithAi } = await import("./visual.ts");
    const { groups, unknown } = await groupByArtWithAi(w.gallery_images);
    if (groups.length < 2) return { groups: 0, jobs: 0 };
    // 代表画像を含む組が同じ大きさなら、そちらを残す
    const keepIdx = groups.findIndex((g) => g.length === groups[0].length && g.includes(w.image_url));
    const keep = groups[keepIdx >= 0 ? keepIdx : 0];
    const moved = groups.filter((g) => g !== keep);
    // この武将は、残す立ち絵の画像だけから作り直す (名前・通常/特異はそのまま)
    const kept = [...keep, ...unknown];
    await db.updateWarlord(
      id,
      normalizeInput({
        ...emptyWarlordInput(),
        name: w.name,
        is_special: w.is_special,
        faction: w.faction,
        oni_season: w.oni_season,
        no_synergy: w.no_synergy,
        gallery_images: [],
        image_url: "",
      }),
    );
    const label = `${w.name} (立ち絵ごとに分ける)`;
    let count = 0;
    count += (
      await queue.enqueue(
        kept.map((imageId, i) => ({ fileName: `${label} 残す${i + 1}`, imageId })),
        "auto",
        id,
        "",
        true,
        { reuse: true },
      )
    ).length;
    for (const [k, g] of moved.entries()) {
      count += (
        await queue.enqueue(
          g.map((imageId, i) => ({ fileName: `${label} 別の立ち絵${k + 1}-${i + 1}`, imageId })),
          "auto",
          null,
          "",
          true,
          { reuse: true, excludeIds: [id] },
        )
      ).length;
    }
    return { groups: moved.length + 1, jobs: count };
  },

  /**
   * 天賦を読み直す (画面の位置から星の番号を決め直す)。ids を渡さなければ、画像のある全員。
   * 武将 1 人につき AI に 1 回問い合わせる (この iPhone で解析する。終わるまでアプリを開いたままにする)
   */
  async rereadTalents(ids?: string[]): Promise<number> {
    // 指定が無ければ、並びがまだ確かめられていない武将だけ (確かめ済みの武将に AI を使わない)
    const list = (await db.listWarlords()).filter(
      (w) => w.gallery_images.length > 0 && (ids ? ids.includes(w.id) : !w.talent_order_v2),
    );
    let count = 0;
    for (const w of list) {
      await queue.enqueue(
        [{ fileName: `${w.is_special ? "【特】" : ""}${w.name} (天賦の読み直し)`, imageId: w.image_url || w.gallery_images[0] }],
        "auto",
        w.id,
        "",
        true,
        { talentsOnly: true },
      );
      count++;
    }
    return count;
  },

  async exportText(): Promise<Blob> {
    const list = (await db.listWarlords()).sort((a, b) => a.name.localeCompare(b.name, "ja") || Number(a.is_special) - Number(b.is_special));
    return new Blob([warlordsToText(list)], { type: "text/plain;charset=utf-8" });
  },

  async exportData(includeImages: boolean): Promise<Blob> {
    const warlords = await db.listWarlords();
    const payload: ExportPayload = { app: "sengoku-fubu-warlord-db", version: 2, exported_at: new Date().toISOString(), warlords };
    if (includeImages) {
      payload.images = {};
      for (const id of new Set(warlords.flatMap((w) => w.gallery_images))) {
        const blob = await db.getImage(id);
        if (blob) payload.images[id] = await blobToDataUrl(blob);
      }
    }
    return new Blob([JSON.stringify(payload)], { type: "application/json" });
  },

  async importData(payload: unknown, mode: "merge" | "replace") {
    const body = payload as Partial<ExportPayload> | Warlord[];
    const list = Array.isArray(body) ? body : body?.warlords;
    if (!Array.isArray(list)) throw new Error("JSON の形式が正しくありません (warlords 配列が必要です)");
    const images = Array.isArray(body) ? undefined : body.images;

    if (images) for (const [id, url] of Object.entries(images)) await db.putImage(await dataUrlToBlob(url), id);
    if (mode === "replace") await db.deleteAllWarlords();

    const imageIds = new Set(await db.listImageIds());
    let created = 0;
    let updated = 0;
    const errors: string[] = [];
    for (const [i, raw] of list.entries()) {
      const input = normalizeInput(raw ?? {});
      if (!input.name) {
        errors.push(`${i + 1} 件目: 武将名がありません`);
        continue;
      }
      // 同じ ID の武将、無ければ名前・通常/特異・勢力が同じ武将を上書きする
      const sameId = typeof raw?.id === "string" ? await db.getWarlord(raw.id) : null;
      const existing =
        sameId ??
        (await db.findByName(input.name)).find((w) => w.is_special === input.is_special && w.faction === input.faction) ??
        null;
      if (existing) {
        // 画像は、この端末にある分を残したまま足す (バックアップより後に加えた画像を外さないため)
        const kept = existing.gallery_images;
        const added = input.gallery_images.filter((g) => !kept.includes(g) && (images?.[g] || imageIds.has(g)));
        await db.updateWarlord(existing.id, normalizeInput({ ...input, gallery_images: [...kept, ...added], image_url: existing.image_url || input.image_url }));
        updated++;
      } else {
        const id = typeof raw?.id === "string" && !(await db.getWarlord(raw.id)) ? raw.id : undefined;
        await db.insertWarlord(input, { id, created_at: typeof raw?.created_at === "string" ? raw.created_at : undefined });
        created++;
      }
    }
    return { created, updated, errors };
  },
};

// 武将を読んでから書き換える操作は、解析結果の保存と重ならないように 1 つずつ行う (変更が消えないように)。
// ※ ここに挙げた操作どうしで呼び合うと順番待ちで止まるので、中から他の api の操作を呼ばないこと
for (const key of ["undoTalentReorders", "autoFixTalentOrder", "dedupeImages", "reanalyzeWarlord", "updateWarlord", "fillPriorities", "fixHimeSpecial", "shareAllOniSynergies", "runHealthCheck", "splitWarlord", "deleteWarlords", "rebuildWarlords", "mergeWarlords", "attachImages", "importData"] as const) {
  const fn = api[key] as (...args: unknown[]) => Promise<unknown>;
  (api as Record<string, unknown>)[key] = (...args: unknown[]) => queue.exclusive(() => fn.apply(api, args));
}
