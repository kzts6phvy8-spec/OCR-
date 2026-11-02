import { AWAKENING_PRIORITIES } from "../../core/types.ts";
import type { ExportPayload, Faction, OcrJob, UploadMode, Warlord, WarlordInput } from "../../core/types.ts";
import { warlordsToText } from "../../core/text.ts";
import { emptyWarlordInput, mergeWarlord, normalizeInput } from "../../core/domain.ts";
import { toInput } from "../../core/ingest.ts";
import { ONI_FACTION, cleanOniSynergies, shareOniSynergies } from "../../core/oni.ts";
import * as db from "./db.ts";
import { blobToDataUrl, compressImage, dataUrlToBlob, shrinkForGallery } from "./images.ts";
import * as queue from "./queue.ts";
import { findIssues, type Issue } from "../../core/health.ts";
import { mergeSynergies } from "../../core/domain.ts";
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
  async fillPriorities(): Promise<{ updated: number; unmatched: number }> {
    let updated = 0;
    let unmatched = 0;
    for (const w of await db.listWarlords()) {
      const record = normalizeInput(toInput(w));
      if (record.awakening_priority !== w.awakening_priority) {
        await db.updateWarlord(w.id, record);
        updated++;
      } else if (record.has_awakening && !AWAKENING_PRIORITIES.includes(record.awakening_priority)) unmatched++;
    }
    return { updated, unmatched };
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
      if (cleaned.removed.length) {
        changed.add(cleaned.warlord.id);
        if (cleaned.movedTo) changed.add(cleaned.movedTo.id);
      }
      for (const c of await shareOniSynergies(db.repo, cleaned.warlord)) changed.add(c.id);
    }
    return changed.size;
  },

  /**
   * 図鑑データを点検し、安全に直せるものは直す。直せないものは知らせるために返す。起動時と「今すぐ点検」で呼ぶ。
   */
  async runHealthCheck(): Promise<HealthReport> {
    const recentLimit = Date.now() - 60 * 60_000;
    const meta = await db.listImageMeta();
    const issues = findIssues(
      await db.listWarlords(),
      new Set(meta.map((m) => m.id)),
      await db.listJobs(),
      // 1 時間以内に保存した画像は、解析待ちに入る前かもしれないので消さない
      new Set(meta.filter((m) => Date.parse(m.created_at) > recentLimit).map((m) => m.id)),
    );
    // ※ 立ち絵が混ざっていそうかを端末の指紋だけで調べるのはやめた (同じ立ち絵でも、画面の種類が違うと指紋が離れて
    //    「混ざっている」と誤って知らせていたため)。混ざりは「画像が 7 枚以上」と、武将の画面の「分ける」(AI で確かめる) で見つける
    const { clearlyDifferentArt } = await import("./visual.ts");
    // 「分かれていそう」でも、立ち絵がはっきり違う武将どうしは別の武将なので知らせない
    for (const issue of [...issues]) {
      if (issue.kind !== "duplicate") continue;
      const group = (await Promise.all(issue.warlordIds.map((id) => db.getWarlord(id)))).filter((w): w is Warlord => Boolean(w));
      let allDifferent = group.length > 1;
      for (let i = 0; i < group.length && allDifferent; i++) {
        for (let j = i + 1; j < group.length && allDifferent; j++) {
          if (!(await clearlyDifferentArt(group[i], group[j]))) allDifferent = false;
        }
      }
      if (allDifferent) issues.splice(issues.indexOf(issue), 1);
    }
    const fixed: Issue[] = [];
    for (const issue of issues.filter((i) => i.autoFix)) {
      try {
        for (const id of issue.warlordIds) {
          const w = await db.getWarlord(id);
          if (!w) continue;
          const input = toInput(w);
          if (issue.kind === "synergy_duplicate") input.synergy_skills = mergeSynergies([], w.synergy_skills);
          if (issue.kind === "hime_special") input.is_special = false;
          if (issue.kind === "missing_image") {
            const missing = new Set(issue.imageIds);
            input.gallery_images = w.gallery_images.filter((g) => !missing.has(g));
            if (missing.has(input.image_url)) input.image_url = input.gallery_images[0] ?? "";
          }
          if (issue.kind === "oni_synergy") {
            await cleanOniSynergies(db.repo, w);
            continue;
          }
          await db.updateWarlord(id, normalizeInput(input));
        }
        if (issue.kind === "orphan_image" && issue.imageIds) await db.deleteImages(issue.imageIds);
        fixed.push(issue);
      } catch (e) {
        issues.push({ ...issue, autoFix: false, message: `${issue.message} …のつもりでしたが、直せませんでした (${(e as Error).message})` });
      }
    }
    const report: HealthReport = { checkedAt: new Date().toISOString(), fixed, warnings: issues.filter((i) => !i.autoFix) };
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
    const images = w.gallery_images.map((imageId, i) => ({ fileName: `${w.name} の画像${i + 1} (再解析)`, imageId }));
    return queue.enqueue(images, "auto", id, "", true);
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
    // まとめた側を指していた解析結果の表示も付け替える
    for (const job of await db.listJobs()) {
      if (job.warlord_id === other.id || job.target_id === other.id) {
        await db.saveJob({ ...job, warlord_id: job.warlord_id === other.id ? keep.id : job.warlord_id, target_id: job.target_id === other.id ? keep.id : job.target_id });
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
      normalizeInput({ ...emptyWarlordInput(), name: w.name, is_special: w.is_special, faction: w.faction, gallery_images: [], image_url: "" }),
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
        await db.updateWarlord(existing.id, input);
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
for (const key of ["updateWarlord", "fillPriorities", "fixHimeSpecial", "shareAllOniSynergies", "runHealthCheck", "splitWarlord", "deleteWarlords", "rebuildWarlords", "mergeWarlords", "attachImages", "importData"] as const) {
  const fn = api[key] as (...args: unknown[]) => Promise<unknown>;
  (api as Record<string, unknown>)[key] = (...args: unknown[]) => queue.exclusive(() => fn.apply(api, args));
}
