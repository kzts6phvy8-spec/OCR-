import { AWAKENING_PRIORITIES } from "../../core/types.ts";
import type { MeishoTalent, ExportPayload, Faction, OcrJob, Talent, UploadMode, Warlord, WarlordInput } from "../../core/types.ts";
import { meishoTrainingToText, warlordsToText } from "../../core/text.ts";
import { warlordLabel } from "../../core/domain.ts";
import { decideSpecial, detectTalentOrder, emptyWarlordInput, hasMeishoMark, stripMeisho, fixTalentOrder, learnTalentStats, talentRules, mergeWarlord, normalizeInput } from "../../core/domain.ts";
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

/**
 * 武将から名将修行の画面を外す (その画面で読んだ追加天賦も外し、残りの画面で丸の入れ方を決め直す)。
 * 名将修行が無くなったら、名将一覧に載っていない武将の名将の印も外す
 */
async function removeTrainingImages(w: Warlord, images: string[]): Promise<void> {
  if (!(w.meisho_images ?? []).some((id) => images.includes(id))) return;
  const { extractionToPatch, normText } = await import("../../core/domain.ts");
  const effects: string[] = [];
  for (const id of images) {
    const ext = await db.getExtraction(id).catch(() => null);
    const t = ext ? extractionToPatch(ext).meisho_talents?.[0] : undefined;
    if (t) effects.push(normText(t.effect));
  }
  const rest = (w.meisho_images ?? []).filter((id) => !images.includes(id));
  // 丸の入れ方を決め直した後は位置が変わっていることがあるので、効果で外す
  const talents = (w.meisho_talents ?? []).filter((t) => !effects.includes(normText(t.effect)));
  const saved = await db.updateWarlord(
    w.id,
    normalizeInput({ ...toInput(w), meisho_images: rest, meisho_talents: talents, ...(rest.length === 0 && talents.length === 0 ? await keepMeishoMark(w) : {}) }),
  );
  const { recomputeMeishoTalents } = await import("./meishoSlots.ts");
  await recomputeMeishoTalents(saved);
}

/**
 * 名将修行を外した武将の名将の印: 名将一覧に勢力ごと載っている・手で決めた武将はそのまま、それ以外は外す
 * (取り違えて名将修行の画面を入れた武将に、名将の印だけが残らないように)
 */
async function keepMeishoMark(w: Warlord): Promise<{ is_meisho: boolean }> {
  if (w.meisho_manual) return { is_meisho: Boolean(w.is_meisho) };
  const { MEISHO_ROSTER } = await import("../../core/meisho.ts");
  return { is_meisho: MEISHO_ROSTER.some((e) => e.faction === w.faction && e.name === w.name) };
}

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
   * 天賦の並びのずれを、解放済み/未解放の並びから見分けて直す (AI なし・起動時に呼ぶ)。
   * 見分けられた武将には印を付け、「天賦を読み直す」の対象から外す
   */
  async autoFixTalentOrder(): Promise<{ fixed: number; unknown: number; cancelled: number }> {
    let fixed = 0;
    const decided = new Set<string>();
    const known: Talent[][] = [];
    let pending: Warlord[] = [];
    for (const w of await db.listWarlords()) {
      // 前の版の自動判断は、星2・星3 まで解放の武将で左右逆の読み取りと取り違えることがあった。
      // その武将は確かめ済みの印を外して、もう一度判断する (1 回だけ)
      if (!w.talent_check_v2) {
        const unlockedCount = w.talents.filter((t) => t.unlocked).length;
        const recheck = w.talent_order_v2 && w.talents.length === 5 && (unlockedCount === 2 || unlockedCount === 3);
        await db.updateWarlord(w.id, normalizeInput({ ...toInput(w), talent_check_v2: true, ...(recheck ? { talent_order_v2: false } : {}) }));
        if (recheck) w.talent_order_v2 = false;
      }
      if (w.talent_order_v2) {
        decided.add(w.id);
        known.push(w.talents);
        continue;
      }
      if (w.talents.length > 0) pending.push(w);
    }
    // 並びが確かな武将から「効果の種類ごとに星いくつに出やすいか」を学び、それで残りを判断する。
    // 決まった武将も学ぶ材料に加えて、決まらなくなるまで繰り返す
    for (let round = 0; round < 5 && pending.length > 0; round++) {
      const stats = learnTalentStats(known);
      const rest: Warlord[] = [];
      for (const w of pending) {
        const order = detectTalentOrder(w.talents, stats);
        if (order === "unknown") {
          rest.push(w);
          continue;
        }
        const talents = fixTalentOrder(w.talents, order);
        await db.updateWarlord(w.id, normalizeInput({ ...toInput(w), talents, talent_order_v2: true }));
        decided.add(w.id);
        known.push(talents);
        if (order !== "ok") fixed++;
      }
      if (rest.length === pending.length) break;
      pending = rest;
    }
    const unknown = pending.length;
    // 並びが決まった武将の、待機中の「天賦の読み直し」は取り消す (AI の回数を使わない)
    const stale = (await db.listJobs()).filter((j) => j.talents_only && j.status === "queued" && j.target_id && decided.has(j.target_id));
    const cancelled = stale.length ? await queue.removeJobs(stale.map((j) => j.id)) : 0;
    return { fixed, unknown, cancelled };
  },

  /** 並びが確かな武将から見つけた天賦の法則 (例: 物理防御は 9 割が星1) */
  async talentRules() {
    const known = (await db.listWarlords()).filter((w) => w.talent_order_v2 && w.talents.length > 0).map((w) => w.talents);
    return { from: known.length, rules: talentRules(learnTalentStats(known)) };
  },

  /**
   * 名将の印を、すでにあるデータから付ける (AI なし・起動時に呼ぶ)。
   * 保存してある読み取り結果や、武将名・二つ名・奥義スキルに「名将一覧」が混ざっている武将に付ける。
   * 前の版は「名将」の 2 文字だけで印を付け、二つ名からその文字を消していたので、二つ名を読み取り結果から戻して判断し直す
   */
  async markMeisho(): Promise<number> {
    let marked = 0;
    for (const w of await db.listWarlords()) {
      // 名将修行の丸の位置を、効果から決まる位置に直す (前の読み取りで位置を読み違えていた分)
      const fixed = normalizeInput(toInput(w)).meisho_talents ?? [];
      if (JSON.stringify(fixed) !== JSON.stringify(w.meisho_talents ?? [])) {
        await db.updateWarlord(w.id, normalizeInput({ ...toInput(w), meisho_talents: fixed }));
        w.meisho_talents = fixed;
      }
      const exts = [];
      for (const id of w.gallery_images) {
        const ext = await db.getExtraction(id).catch(() => null);
        if (ext) exts.push(ext);
      }
      // 前の版で消してしまった二つ名の「名将」を戻す
      const lostAlias = w.title_alias.includes("名将")
        ? null
        : exts.map((e) => stripMeisho(String(e.title_alias ?? "").replace(/【\s*特\s*】/g, ""))).find((a) => a.includes("名将"));
      const evidence = exts.some(hasMeishoMark) || hasMeishoMark({ name: w.name, title_alias: w.title_alias, skill: { name: w.skill_name, desc: w.skill_desc, gauge: null } });
      // 手で決めた武将は、印を変えない
      const is_meisho = w.meisho_manual ? Boolean(w.is_meisho) : evidence || Boolean(w.is_meisho && !lostAlias);
      if (is_meisho === Boolean(w.is_meisho) && !lostAlias && !evidence) continue;
      const next = {
        ...toInput(w),
        name: stripMeisho(w.name) || w.name,
        title_alias: lostAlias ?? stripMeisho(w.title_alias),
        skill_name: stripMeisho(w.skill_name),
        skill_desc: stripMeisho(w.skill_desc),
        is_meisho,
      };
      const changed = (["name", "title_alias", "skill_name", "skill_desc", "is_meisho"] as const).some((k) => next[k] !== (w[k] ?? false));
      if (!changed) continue;
      await db.updateWarlord(w.id, normalizeInput(next));
      if (is_meisho && !w.is_meisho) marked++;
    }
    // ゲーム内の「名将一覧」と勢力・名前が合う武将にも付ける (同じ勢力に同じ名前が一覧より多い時は、立ち絵で選んでもらう)
    const { matchMeishoRoster } = await import("../../core/meisho.ts");
    for (const m of matchMeishoRoster(await db.listWarlords())) {
      for (const w of m.decided) {
        if (w.is_meisho || w.meisho_manual) continue;
        await db.updateWarlord(w.id, normalizeInput({ ...toInput(w), is_meisho: true }));
        marked++;
      }
    }
    return marked;
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
      images.push(...current.gallery_images, ...(current.meisho_images ?? []));
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
  async retryJobWithTarget(id: string, targetId: string) {
    // 名将修行の画面を手で振り分けた武将は、以後も名将修行の画面の見分けの候補にする
    const job = await db.getJob(id);
    const w = await db.getWarlord(targetId);
    if (job?.extraction?.meisho_training?.visible && w && !w.meisho_training_manual) {
      await db.updateWarlord(w.id, normalizeInput({ ...toInput(w), meisho_training_manual: true }));
    }
    return queue.retryJobs([id], targetId);
  },
  /**
   * 失敗したジョブを、新しい武将として保存し直す (統合先に合う武将がいない時)。
   * 名前と通常/特異だけの武将を作り、そこへ統合する形で保存する (読み取り済みなら AI は使わない)。
   */
  async retryJobAsNewWarlord(id: string, name: string, opts: { faction?: Faction; meisho?: boolean } = {}): Promise<Warlord> {
    const job = await db.getJob(id);
    if (!job) throw new Error("解析の記録が見つかりません");
    if (job.status !== "error") throw new Error("この解析は、すでにやり直し中か完了しています");
    const isSpecial = job.extraction ? decideSpecial(job.extraction, job.mode).is_special : job.mode === "force_special";
    const created = await db.insertWarlord(
      normalizeInput({
        ...emptyWarlordInput(),
        name,
        is_special: isSpecial,
        ...(opts.faction ? { faction: opts.faction } : {}),
        // 名将一覧から作った武将は名将 (手で決めた扱い)
        ...(opts.meisho ? { is_meisho: true, meisho_manual: true } : {}),
      }),
    );
    // 読み取りがまだの (送信や解析で失敗した) 画像は、読み取った【特】表記で通常/特異を決め直す
    await queue.retryJobs([id], created.id, true);
    return created;
  },
  removeJobs: (ids: string[]) => queue.removeJobs(ids),
  takeOverRemoteJobs: () => queue.takeOverRemoteJobs(),
  sendLocalJobsToServer: () => queue.sendLocalJobsToServer(),
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
        is_meisho: w.is_meisho,
        meisho_manual: w.meisho_manual,
        // 名将修行の画面は登録画像に残さないので、読み取った追加天賦は作り直しで消さない
        meisho_talents: w.meisho_talents,
        meisho_images: w.meisho_images,
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
  /**
   * 天賦を AI で読み直す武将。指定が無ければ、天賦の法則に当てはまらない武将だけ:
   *  - 並びを法則で決められなかった武将
   *  - 並びは確かめ済みでも、法則とはっきり食い違う武将 (AI で読み直した武将は除く。それは本当にそういう武将)
   */
  async talentRereadTargets(): Promise<{ undecided: Warlord[]; conflicting: Warlord[] }> {
    const all = (await db.listWarlords()).filter((w) => w.gallery_images.length > 0);
    const stats = learnTalentStats(all.filter((w) => w.talent_order_v2 && w.talents.length > 0).map((w) => w.talents));
    const undecided = all.filter((w) => !w.talent_order_v2);
    const conflicting = all.filter((w) => w.talent_order_v2 && !w.talent_ai_read && w.talents.length > 0 && !["ok", "unknown"].includes(detectTalentOrder(w.talents, stats)));
    return { undecided, conflicting };
  },

  async rereadTalents(ids?: string[]): Promise<number> {
    let list: Warlord[];
    if (ids) {
      list = (await db.listWarlords()).filter((w) => w.gallery_images.length > 0 && ids.includes(w.id));
    } else {
      const t = await api.talentRereadTargets();
      list = [...t.undecided, ...t.conflicting];
    }
    // すでに待機中の読み直しがある武将は二重に入れない
    const waiting = new Set((await db.listJobs()).filter((j) => j.talents_only && (j.status === "queued" || j.status === "processing")).map((j) => j.target_id));
    let count = 0;
    for (const w of list) {
      if (waiting.has(w.id)) continue;
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

  /**
   * 全武将の立ち絵 (代表画像の左側) を ZIP ファイルにまとめる (1 つ 28MB 以下になるように分ける)。
   * ファイル名は「【特】武将名(二つ名)_レア度_勢力.jpg」
   */
  async exportArtZip(onProgress?: (done: number, total: number) => void, maxBytes = 28_000_000): Promise<{ blobs: Blob[]; count: number; missing: number }> {
    const { crc32, splitForZip, zipParts, safeFileName } = await import("../../core/zip.ts");
    const { cropLeft } = await import("./images.ts");
    const list = (await db.listWarlords()).sort(
      (a, b) => a.name.localeCompare(b.name, "ja") || Number(a.is_special) - Number(b.is_special) || a.faction.localeCompare(b.faction, "ja"),
    );
    const entries: { name: string; data: Blob; crc: number }[] = [];
    const used = new Set<string>();
    let missing = 0;
    for (const [i, w] of list.entries()) {
      onProgress?.(i, list.length);
      const id = w.image_url || w.gallery_images[0];
      const image = id ? await db.getImage(id).catch(() => null) : null;
      if (!image) {
        missing++;
        continue;
      }
      let art: Blob;
      try {
        art = await cropLeft(image, 0.45, 1200);
      } catch {
        missing++;
        continue;
      }
      const base = safeFileName(
        [`${w.is_special ? "【特】" : ""}${w.name}${w.title_alias ? `(${w.title_alias})` : ""}`, w.rarity, w.faction].filter(Boolean).join("_"),
      );
      let name = `${base}.jpg`;
      for (let n = 2; used.has(name); n++) name = `${base}_${n}.jpg`;
      used.add(name);
      // 中身は Blob のまま持つ (全員分を読み込んだままにすると iPhone のメモリが足りなくなる)
      entries.push({ name, data: art, crc: crc32(new Uint8Array(await art.arrayBuffer())) });
    }
    onProgress?.(list.length, list.length);
    // アップロードできる大きさに収まるよう、いくつかの ZIP に分ける
    const blobs = splitForZip(entries, maxBytes).map((g) => new Blob(zipParts(g), { type: "application/zip" }));
    return { blobs, count: entries.length, missing };
  },

  /**
   * 名将一覧の名前だけでは決められない武将 (同じ勢力に同じ名前が何人もいる) を、AI に登録画像を見せて見分ける。
   * 1 人につき AI に 1 回。上限に達したらそこで止める
   */
  async checkAmbiguousMeisho(onProgress?: (done: number, total: number, name: string) => void): Promise<{ marked: number; notMeisho: number; unknown: string[]; stopped: string }> {
    const { matchMeishoRoster } = await import("../../core/meisho.ts");
    const { checkMeishoWithAi } = await import("./meishoCheck.ts");
    const targets = matchMeishoRoster(await db.listWarlords())
      .filter((m) => m.candidates.length > 0 && m.decided.length === 0)
      // 手で決めた名前の組は AI に聞かない
      .filter((m) => !m.candidates.some((w) => w.meisho_manual))
      .flatMap((m) => m.candidates);
    let marked = 0;
    let notMeisho = 0;
    const unknown: string[] = [];
    let stopped = "";
    for (const [i, w] of targets.entries()) {
      const label = `${w.is_special ? "【特】" : ""}${w.name}`;
      onProgress?.(i, targets.length, label);
      let result: boolean | null;
      try {
        result = await checkMeishoWithAi(w);
      } catch (e) {
        stopped = e instanceof Error ? e.message : String(e);
        break;
      }
      if (result === null) {
        unknown.push(label);
        continue;
      }
      const fresh = await db.getWarlord(w.id);
      if (!fresh) continue;
      if (Boolean(fresh.is_meisho) !== result) await db.updateWarlord(fresh.id, normalizeInput({ ...toInput(fresh), is_meisho: result }));
      if (result) marked++;
      else notMeisho++;
    }
    onProgress?.(targets.length, targets.length, "");
    return { marked, notMeisho, unknown, stopped };
  },

  /**
   * 名将修行の画面を、保存してある画像と読み取り結果から見分け直す (読み取りはやり直さない)。
   * 全員の名将修行の追加天賦をいったん空にし、画像ごとに誰の画面かを決め直して入れ直す。見分け直す画像の枚数を返す
   */
  /**
   * 取り違えて入った名将修行の画面を外して、見分け直す (起動時に呼ぶ)。
   * シミュレーターに直接渡したデータがある名将で、同じ丸の効果がはっきり違う画面は、別の名将の画面なので外す。外した枚数を返す
   */
  async fixMisassignedTraining(): Promise<number> {
    const { contradictsSimMeisho, simEvidence, simMeishoTalents } = await import("../../core/meishoSimData.ts");
    const { extractionToPatch, normText } = await import("../../core/domain.ts");
    const moved: string[] = [];
    for (const w of await db.listWarlords()) {
      if (!w.meisho_images?.length) continue;
      const reads: { id: string; effect: string; rank: string; slot: string; trained: boolean }[] = [];
      for (const id of w.meisho_images) {
        const ext = await db.getExtraction(id).catch(() => null);
        const read = ext ? extractionToPatch(ext).meisho_talents?.[0] : undefined;
        if (read) reads.push({ id, ...read });
      }
      // シミュレーターに名将修行を直接渡した名将に、その名将らしい追加天賦が 1 つも無い画面が自動で入っていたら取り違え
      // (利用者が手で振り分けた名将は除く)
      const unsure = Boolean(simMeishoTalents(w)) && !w.meisho_training_manual && simEvidence(w, reads) !== "match";
      const wrong = reads.filter((r) => unsure || contradictsSimMeisho(w, r));
      if (wrong.length === 0) continue;
      const wrongIds = new Set(wrong.map((x) => x.id));
      const talents = (w.meisho_talents ?? []).filter(
        (t) => !wrong.some((x) => x.rank === t.rank && x.slot === t.slot && normText(x.effect) === normText(t.effect)),
      );
      const rest = w.meisho_images.filter((id) => !wrongIds.has(id));
      await db.updateWarlord(
        w.id,
        normalizeInput({ ...toInput(w), meisho_images: rest, meisho_talents: talents, ...(rest.length === 0 && talents.length === 0 ? await keepMeishoMark(w) : {}) }),
      );
      moved.push(...wrongIds);
    }
    if (moved.length) {
      await queue.enqueue(
        moved.map((id, i) => ({ fileName: `名将修行の画面 ${i + 1} (取り違えの見分け直し)`, imageId: id })),
        "auto",
        null,
        "",
        true,
        { reuse: true },
      );
    }
    return moved.length;
  },

  /**
   * どの名将にも入っていない名将修行の画面 (見分けに失敗した・取り違えて消した等) の画像。
   * 解析待ち・サーバーに預け中のものは除く
   */
  async unassignedTrainingImages(): Promise<string[]> {
    const images = await db.listTrainingImages();
    const assigned = new Set((await db.listWarlords()).flatMap((w) => w.meisho_images ?? []));
    const busy = new Set((await db.listJobs()).filter((j) => j.status === "queued" || j.status === "processing" || j.status === "remote").map((j) => j.image_id));
    return images.filter((id) => !assigned.has(id) && !busy.has(id));
  },

  /** どの名将にも入っていない名将修行の画面だけを、もう一度見分ける (読み取りはやり直さない)。枚数を返す */
  async reidentifyUnassignedTraining(): Promise<number> {
    const ids = await api.unassignedTrainingImages();
    if (ids.length === 0) return 0;
    // 失敗のまま残っている同じ画像の記録は、二重にならないよう取り除く
    const failed = (await db.listJobs()).filter((j) => j.status === "error" && ids.includes(j.image_id)).map((j) => j.id);
    if (failed.length) await db.deleteJobs(failed);
    await queue.enqueue(
      ids.map((id, i) => ({ fileName: `名将修行の画面 ${i + 1} (見分け直し)`, imageId: id })),
      "auto",
      null,
      "",
      true,
      { reuse: true },
    );
    return ids.length;
  },

  async reidentifyMeishoTraining(): Promise<number> {
    const all = await db.listTrainingImages();
    // 手で振り分けた名将の画面はそのまま残す (見分け直さない)
    const warlords = await db.listWarlords();
    const kept = new Set(warlords.filter((w) => w.meisho_training_manual).flatMap((w) => w.meisho_images ?? []));
    // 解析待ち・サーバーに預け中の画面は、二重にしない
    const jobs = await db.listJobs();
    const busy = new Set(jobs.filter((j) => j.status === "queued" || j.status === "processing" || j.status === "remote").map((j) => j.image_id));
    const images = all.filter((id) => !kept.has(id) && !busy.has(id));
    if (images.length === 0) return 0;
    for (const w of warlords) {
      if (w.meisho_training_manual || (!w.meisho_talents?.length && !w.meisho_images?.length)) continue;
      await db.updateWarlord(w.id, normalizeInput({ ...toInput(w), meisho_talents: [], meisho_images: [], ...(await keepMeishoMark(w)) }));
    }
    // 失敗のまま残っている同じ画像の記録は取り除く (見分け直しの記録と二重にならないように)
    const failed = jobs.filter((j) => j.status === "error" && images.includes(j.image_id)).map((j) => j.id);
    if (failed.length) await db.deleteJobs(failed);
    await queue.enqueue(
      images.map((id, i) => ({ fileName: `名将修行の画面 ${i + 1} (見分け直し)`, imageId: id })),
      "auto",
      null,
      "",
      true,
      { reuse: true },
    );
    return images.length;
  },

  /** 1 人の武将の名将修行の追加天賦を消す (取り違えて入った時に) */
  async clearMeishoTraining(id: string): Promise<Warlord> {
    const w = await db.getWarlord(id);
    if (!w) throw new Error("武将が見つかりません");
    const saved = await db.updateWarlord(id, normalizeInput({ ...toInput(w), meisho_talents: [], meisho_images: [], ...(await keepMeishoMark(w)) }));
    await db.removeUnreferencedImages(w.meisho_images ?? []);
    return saved;
  },

  /**
   * 保存してある名将修行の画面を、カードの絵が同じものどうし (= 同じ名将) の組に分けて返す。
   * 組ごとに、いま入っている武将と、読んだ追加天賦も返す (手で振り分ける画面用)
   */
  async trainingGroups(): Promise<{ images: string[]; owners: Warlord[]; talents: MeishoTalent[] }[]> {
    const { groupTrainingImages } = await import("./visual.ts");
    const { extractionToPatch } = await import("../../core/domain.ts");
    const warlords = await db.listWarlords();
    const groups = await groupTrainingImages(await db.listTrainingImages());
    const out: { images: string[]; owners: Warlord[]; talents: MeishoTalent[] }[] = [];
    for (const images of groups) {
      const owners = warlords.filter((w) => (w.meisho_images ?? []).some((id) => images.includes(id)));
      const talents: MeishoTalent[] = [];
      for (const id of images) {
        const ext = await db.getExtraction(id).catch(() => null);
        const t = ext ? extractionToPatch(ext).meisho_talents?.[0] : undefined;
        if (t) talents.push(t);
      }
      out.push({ images, owners, talents });
    }
    return out;
  },

  /** 解析が終わった画面 1 枚を、もう一度読み取って同じ武将に保存し直す (AI で読み直す) */
  async reanalyzeJob(jobId: string): Promise<void> {
    const job = await db.getJob(jobId);
    if (!job || job.status !== "done") throw new Error("この解析は、まだ終わっていません");
    await queue.enqueue([{ fileName: `${job.file_name} (再解析)`, imageId: job.image_id }], job.mode, job.warlord_id, job.faction ?? "", true);
    await db.deleteJobs([jobId]);
    queue.notifyQueueChange();
  },

  /** 解析が終わった名将修行の画面 1 枚を、手で選んだ名将に入れ直す (前に入っていた名将からは外す。AI なし) */
  async reassignTrainingImage(jobId: string, imageId: string, warlordId: string): Promise<Warlord> {
    await api.assignTrainingGroup([imageId], warlordId);
    const w = await db.getWarlord(warlordId);
    if (!w) throw new Error("武将が見つかりません");
    await queue.patchJob(jobId, { warlord_id: w.id, warlord_label: warlordLabel(w), warnings: ["手で選んだ名将に入れ直しました"] });
    return w;
  },

  /** 解析が終わった名将修行の画面 1 枚を、誰の画面か見分け直す (今入っている名将は候補から外す。読み取りはやり直さない) */
  async reidentifyTrainingImage(jobId: string, imageId: string): Promise<void> {
    const owners = (await db.listWarlords()).filter((w) => (w.meisho_images ?? []).includes(imageId));
    await queue.enqueue([{ fileName: "名将修行の画面 (見分け直し)", imageId }], "auto", null, "", true, {
      reuse: true,
      excludeIds: owners.map((w) => w.id),
    });
    // 新しい記録が画像を使うので、外しても画像は消えない
    for (const w of owners) await removeTrainingImages(w, [imageId]);
    await db.deleteJobs([jobId]);
    queue.notifyQueueChange();
  },

  /** 名将修行の画面の組を、手で選んだ名将に入れる (前に入っていた武将からは外す。AI なし) */
  async assignTrainingGroup(images: string[], warlordId: string): Promise<void> {
    const { extractionToPatch, mergeMeishoTalents, normText } = await import("../../core/domain.ts");
    const read: MeishoTalent[] = [];
    for (const id of images) {
      const ext = await db.getExtraction(id).catch(() => null);
      const t = ext ? extractionToPatch(ext).meisho_talents?.[0] : undefined;
      if (t) read.push(t);
    }
    for (const w of await db.listWarlords()) {
      if (w.id === warlordId) continue;
      await removeTrainingImages(w, images);
    }
    const to = await db.getWarlord(warlordId);
    if (!to) throw new Error("武将が見つかりません");
    await db.updateWarlord(
      to.id,
      normalizeInput({
        ...toInput(to),
        is_meisho: true,
        meisho_training_manual: true,
        meisho_images: [...(to.meisho_images ?? []), ...images],
        meisho_talents: mergeMeishoTalents(to.meisho_talents ?? [], read),
      }),
    );
    const { recomputeMeishoTalents } = await import("./meishoSlots.ts");
    const saved = await db.getWarlord(warlordId);
    if (saved) await recomputeMeishoTalents(saved);
    // この画面の見分けを待っている・失敗したままの記録は取り除く (後から別の武将に入らないように)。
    // 画像は名将に入れた後なので、記録を取り除いても消えない
    const pending = (await db.listJobs()).filter((j) => images.includes(j.image_id) && j.status !== "done" && j.status !== "processing").map((j) => j.id);
    if (pending.length) await queue.removeJobs(pending);
  },

  /** 名将修行の追加天賦と画面を、別の武将に移す (同じ名前の別の勢力の武将に入れてしまった時など) */
  async moveMeishoTraining(fromId: string, toId: string): Promise<{ from: Warlord; to: Warlord }> {
    const from = await db.getWarlord(fromId);
    const to = await db.getWarlord(toId);
    if (!from || !to) throw new Error("武将が見つかりません");
    const { mergeMeishoTalents } = await import("../../core/domain.ts");
    const movedTo = await db.updateWarlord(
      to.id,
      normalizeInput({
        ...toInput(to),
        is_meisho: true,
        meisho_training_manual: true,
        meisho_talents: mergeMeishoTalents(to.meisho_talents ?? [], from.meisho_talents ?? []),
        meisho_images: [...(to.meisho_images ?? []), ...(from.meisho_images ?? [])],
      }),
    );
    // 名将修行の画面を入れた時に付いた名将の印も、名将一覧に載っていない武将なら外す (手で決めた印はそのまま)
    const movedFrom = await db.updateWarlord(
      from.id,
      normalizeInput({ ...toInput(from), meisho_talents: [], meisho_images: [], ...(await keepMeishoMark(from)) }),
    );
    const { recomputeMeishoTalents } = await import("./meishoSlots.ts");
    return { from: movedFrom, to: await recomputeMeishoTalents(movedTo) };
  },

  /** 名将かどうかを手で決める (自動の判断で変えなくなる) */
  async setMeisho(id: string, value: boolean): Promise<Warlord> {
    const w = await db.getWarlord(id);
    if (!w) throw new Error("武将が見つかりません");
    return db.updateWarlord(id, normalizeInput({ ...toInput(w), is_meisho: value, meisho_manual: true }));
  },

  /** 名将の武将だけを書き出す (テキスト / JSON) */
  async exportMeisho(format: "txt" | "json" | "training"): Promise<{ blob: Blob; count: number }> {
    const { SIM_MEISHO, simMeishoNotIn } = await import("../../core/meishoSimData.ts");
    const { MEISHO_SLOTS } = await import("../../core/types.ts");
    const all = await db.listWarlords();
    const meisho: Warlord[] = [];
    const used = new Set<string>();
    // シミュレーターに直接渡した名将: 同じ勢力・名前の武将が図鑑に何人いても 1 人だけ書き出す
    // (図鑑で読み取ったデータがある武将 → 名将の印がある武将 → 通常/特異が合う武将 の順に選ぶ)
    for (const m of SIM_MEISHO) {
      const twins = SIM_MEISHO.filter((x) => x.faction === m.faction && x.name === m.name).length > 1;
      const same = all.filter((w) => w.faction === m.faction && w.name === m.name && !used.has(w.id) && (!twins || w.is_special === m.special));
      if (same.length === 0) continue;
      const pick =
        same.find((w) => w.meisho_talents?.length) ?? same.find((w) => w.is_meisho) ?? same.find((w) => w.is_special === m.special) ?? same[0];
      used.add(pick.id);
      // 同じ勢力・名前の他の武将は名将として書き出さない (名将ではない通常/特異の武将)
      for (const w of same) used.add(w.id);
      meisho.push(
        pick.meisho_talents?.length
          ? pick
          : { ...pick, is_meisho: true, meisho_talents: m.effects.map((effect, k) => ({ ...MEISHO_SLOTS[k], effect, trained: true })), meisho_source: "simulator" },
      );
    }
    // それ以外の名将 (図鑑で読み取る名将)。同じ勢力・名前で何人もいる時は、データがある武将を 1 人だけ
    const rest = all.filter((w) => w.is_meisho && !used.has(w.id));
    for (const w of rest) {
      const same = rest.filter((x) => x.faction === w.faction && x.name === w.name);
      const pick = same.find((x) => x.meisho_talents?.length) ?? same[0];
      if (pick.id !== w.id) continue;
      meisho.push(w);
    }
    // シミュレーターにはあるが、図鑑にまだいない名将も入れる
    const now = new Date().toISOString();
    for (const m of simMeishoNotIn(all)) {
      meisho.push({
        ...normalizeInput({ ...emptyWarlordInput(), name: m.name, faction: m.faction as Faction, is_special: m.special, is_meisho: true, meisho_talents: m.talents }),
        id: `sim-${m.faction}-${m.name}-${m.special ? "s" : "n"}`,
        created_at: now,
        updated_at: now,
        screenshot_count: 0,
        meisho_source: "simulator",
      });
    }
    // 名将全員が同じ丸 (少史 上: 兵数上限+175、少納言 下: 物理計略防御+20%) が足りない名将は、推定で埋める (書き出しの時だけ)
    for (const [k, w] of meisho.entries()) {
      const talents = [...(w.meisho_talents ?? [])];
      const add = (rank: string, slot: string, effect: string) => {
        if (!talents.some((t) => t.rank === rank && t.slot === slot)) talents.push({ rank, slot, effect, trained: false, estimated: true });
      };
      add("少史", "上", "兵数上限+175");
      add("少納言", "下", "物理計略防御+20%");
      const order = (t: MeishoTalent) => MEISHO_SLOTS.findIndex((s) => s.rank === t.rank && s.slot === t.slot);
      meisho[k] = { ...w, meisho_talents: talents.sort((a, b) => order(a) - order(b)) };
    }
    const list = meisho.sort(
      (a, b) => a.faction.localeCompare(b.faction, "ja") || a.name.localeCompare(b.name, "ja") || Number(a.is_special) - Number(b.is_special),
    );
    if (format === "training") return { blob: new Blob([meishoTrainingToText(list)], { type: "text/plain;charset=utf-8" }), count: list.length };
    if (format === "txt") return { blob: new Blob([warlordsToText(list)], { type: "text/plain;charset=utf-8" }), count: list.length };
    const payload: ExportPayload = { app: "sengoku-fubu-warlord-db", version: 2, exported_at: new Date().toISOString(), warlords: list };
    return { blob: new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), count: list.length };
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
for (const key of ["autoFixTalentOrder", "markMeisho", "fixMisassignedTraining", "assignTrainingGroup", "reidentifyTrainingImage", "dedupeImages", "reanalyzeWarlord", "updateWarlord", "fillPriorities", "fixHimeSpecial", "shareAllOniSynergies", "runHealthCheck", "splitWarlord", "deleteWarlords", "rebuildWarlords", "mergeWarlords", "attachImages", "importData"] as const) {
  const fn = api[key] as (...args: unknown[]) => Promise<unknown>;
  (api as Record<string, unknown>)[key] = (...args: unknown[]) => queue.exclusive(() => fn.apply(api, args));
}
