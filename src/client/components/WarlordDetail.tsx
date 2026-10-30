import { useEffect, useState, type ReactNode } from "react";
import {
  Camera,
  ChevronLeft,
  ImagePlus,
  Loader2,
  Merge,
  RotateCcw,
  Split,
  Copy,
  ChevronRight,
  Lock,
  Pencil,
  Plus,
  Save,
  Sparkles,
  Swords,
  Trash2,
  Unlock,
  Users,
  X,
} from "lucide-react";
import {
  AWAKENING_PRIORITIES,
  FACTIONS,
  RARITIES,
  isPending,
  type Talent,
  type Warlord,
  type WarlordInput,
} from "../../core/types.ts";
import { api } from "../lib/api.ts";
import { useToast } from "../lib/toast.tsx";
import { RarityBadge, SpecialBadge, Stars, WeaponBadge } from "./Badges.tsx";
import { warlordToText } from "../../core/text.ts";
import { StoredImage } from "./StoredImage.tsx";
import { WarlordPicker } from "./WarlordPicker.tsx";
import { onQueueChange } from "../lib/queue.ts";
import { differsByOneChar } from "../../core/ingest.ts";

const EMPTY: WarlordInput = {
  name: "",
  is_special: false,
  title_alias: "",
  rarity: "",
  faction: "",
  level: 0,
  stars: 0,
  growth_total: "",
  attack_base: 0,
  attack_growth: "",
  defense_base: 0,
  defense_growth: "",
  stratagem_base: 0,
  stratagem_growth: "",
  troops_base: 0,
  troops_growth: "",
  skill_name: "",
  skill_gauge: 0,
  skill_desc: "",
  has_awakening: false,
  awakening_skill_name: "",
  awakening_priority: "",
  has_weapon_awakening: false,
  awakening_before_weapon: "",
  awakening_after_weapon: "",
  talents: [],
  troop_type: "",
  troop_variants: [],
  synergy_skills: [],
  image_url: "",
  gallery_images: [],
};

function toInput(w: Warlord): WarlordInput {
  const { id: _i, created_at: _c, updated_at: _u, screenshot_count: _s, ...rest } = w;
  return structuredClone(rest);
}

const STATS = [
  { key: "attack", label: "攻", color: "from-hi-600 to-hi-400" },
  { key: "defense", label: "防", color: "from-sky-700 to-sky-400" },
  { key: "stratagem", label: "計", color: "from-violet-700 to-violet-400" },
  { key: "troops", label: "兵", color: "from-emerald-700 to-emerald-400" },
] as const;

interface Props {
  warlord: Warlord | null;
  allWarlords: Warlord[];
  onClose: () => void;
  onSaved: (w: Warlord) => void;
  onDeleted: () => void;
  onOpenOther: (id: string) => void;
}

export function WarlordDetail({ warlord, allWarlords, onClose, onSaved, onDeleted, onOpenOther }: Props) {
  const toast = useToast();
  const [editing, setEditing] = useState(warlord === null);
  const [draft, setDraft] = useState<WarlordInput>(() => (warlord ? toInput(warlord) : structuredClone(EMPTY)));
  const [saving, setSaving] = useState(false);
  const [lightbox, setLightbox] = useState<number | null>(null);

  // 編集を始めた時の内容。保存する時は、ここから変えた項目だけを送る
  // (編集中に解析結果がこの武将に統合されても、その内容を古い値で上書きしない)
  const [original, setOriginal] = useState<WarlordInput | null>(() => (warlord ? toInput(warlord) : null));
  const [updatedWhileEditing, setUpdatedWhileEditing] = useState(false);

  useEffect(() => {
    setEditing(warlord === null);
    setDraft(warlord ? toInput(warlord) : structuredClone(EMPTY));
    setOriginal(warlord ? toInput(warlord) : null);
    setUpdatedWhileEditing(false);
  }, [warlord?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!warlord) return;
    if (editing) {
      // 編集中は入力中の内容を消さない (知らせだけ出す)
      if (original && warlord.updated_at && JSON.stringify(toInput(warlord)) !== JSON.stringify(original)) setUpdatedWhileEditing(true);
      return;
    }
    setDraft(toInput(warlord));
    setOriginal(toInput(warlord));
  }, [warlord?.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && lightbox === null) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox, onClose]);

  // この武将に統合する解析 (スクショ追加・再解析) の残り枚数
  const [pendingCount, setPendingCount] = useState(0);
  useEffect(() => {
    if (!warlord) return;
    const refresh = () =>
      void api.jobs().then((jobs) => setPendingCount(jobs.filter((j) => j.target_id === warlord.id && isPending(j.status)).length));
    refresh();
    const off = onQueueChange(refresh);
    return () => void off();
  }, [warlord?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const [adding, setAdding] = useState(false);
  const addScreenshots = async (files: FileList | null) => {
    if (!warlord || !files) return;
    const images = Array.from(files).filter((f) => f.type.startsWith("image/") || /\.(jpe?g|png|heic|heif|webp)$/i.test(f.name));
    if (images.length === 0) return;
    setAdding(true);
    try {
      const jobs = await api.upload(images, { mode: "auto", targetId: warlord.id, faction: "" }, () => {});
      toast("info", `${jobs.length} 枚を「${warlord.name}」に統合するよう解析します`, "空欄の項目だけが埋まります。すでに入っている値は変わりません");
    } catch (e) {
      toast("error", "画像の読み込みに失敗しました", (e as Error).message);
    } finally {
      setAdding(false);
    }
  };
  const reanalyze = async () => {
    if (!warlord) return;
    if (!confirm(`登録済みの ${warlord.gallery_images.length} 枚を、もう一度解析して「${warlord.name}」に統合しますか？\n空欄の項目だけが埋まります。`)) return;
    const jobs = await api.reanalyzeWarlord(warlord.id);
    toast("info", `${jobs.length} 枚を再解析します`, "進み具合は「スクショ解析」タブでも見られます");
  };

  const rebuild = async () => {
    if (!warlord) return;
    const same = allWarlords.filter((w) => w.name === warlord.name);
    const images = new Set(same.flatMap((w) => w.gallery_images)).size;
    if (
      !confirm(
        `「${warlord.name}」(${same.length > 1 ? "通常・特異の両方" : warlord.is_special ? "特異" : "通常"}) を、登録画像 ${images} 枚から作り直しますか？\n\n` +
          "立ち絵を見比べて通常・特異を分け直します。手で直した内容は消えます。画像は残ります。\n" +
          `AI の回数を ${images} 回以上使います。`,
      )
    )
      return;
    const { jobs } = await api.rebuildWarlords(warlord.name);
    toast("info", `「${warlord.name}」を ${jobs.length} 枚の画像から作り直します`, "進み具合は「スクショ解析」タブで見られます");
    onDeleted();
  };

  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeId, setMergeId] = useState("");
  // まとめる候補: 同じ名前・似た名前の武将を先に並べる
  const mergeCandidates = warlord
    ? allWarlords
        .filter((w) => w.id !== warlord.id)
        .map((w) => ({ w, near: w.name === warlord.name ? 0 : differsByOneChar(w.name, warlord.name) ? 1 : 2 }))
        .sort((a, b) => a.near - b.near || a.w.name.localeCompare(b.w.name, "ja"))
    : [];
  const mergeOther = async () => {
    const other = allWarlords.find((w) => w.id === mergeId);
    if (!warlord || !other) return;
    const label = (w: Warlord) => `${w.is_special ? "【特】" : ""}${w.name}`;
    if (!confirm(`「${label(other)}」を「${label(warlord)}」にまとめますか？\n\n空欄だけが「${label(other)}」の内容で埋まり、画像は両方残ります。「${label(other)}」は消えます。`)) return;
    try {
      const saved = await api.mergeWarlords(warlord.id, other.id);
      toast("success", `「${label(other)}」をまとめました`, label(saved));
      setMergeOpen(false);
      setMergeId("");
      onSaved(saved);
    } catch (e) {
      toast("error", "まとめられませんでした", (e as Error).message);
    }
  };

  const counterpart = warlord
    ? allWarlords.find((w) => w.name === warlord.name && w.is_special !== warlord.is_special)
    : undefined;

  // 手動登録の時に添えるスクショ (保存した後で、この武将に統合するよう解析する)
  const [newFiles, setNewFiles] = useState<File[]>([]);
  const [analyzeNew, setAnalyzeNew] = useState(true);

  const save = async () => {
    if (!draft.name.trim()) return toast("error", "武将名を入力してください");
    setSaving(true);
    try {
      let saved = warlord ? await api.updateWarlord(warlord.id, changedFields(original ?? toInput(warlord), draft)) : await api.createWarlord(draft);
      if (!warlord && newFiles.length > 0) {
        if (analyzeNew) {
          await api.upload(newFiles, { mode: "auto", targetId: saved.id, faction: "" }, () => {});
          toast("info", `${newFiles.length} 枚を「${saved.name}」に統合するよう解析します`, "空欄の項目が埋まります。入力した内容は変わりません");
        } else {
          saved = await api.attachImages(saved.id, newFiles);
        }
        setNewFiles([]);
      }
      toast("success", "保存しました", saved.name);
      setEditing(false);
      setUpdatedWhileEditing(false);
      onSaved(saved);
    } catch (e) {
      toast("error", "保存に失敗しました", (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!warlord || !confirm(`「${warlord.is_special ? "【特】" : ""}${warlord.name}」を削除しますか？\n登録画像も削除されます。`)) return;
    try {
      await api.deleteWarlord(warlord.id);
      toast("success", "削除しました", warlord.name);
      onDeleted();
    } catch (e) {
      toast("error", "削除に失敗しました", (e as Error).message);
    }
  };

  const toggleSpecial = async () => {
    if (!warlord) return;
    try {
      const saved = await api.updateWarlord(warlord.id, { is_special: !warlord.is_special });
      toast("success", saved.is_special ? "特異武将に変更しました" : "通常武将に変更しました", saved.name);
      onSaved(saved);
    } catch (e) {
      toast("error", "変更できませんでした", (e as Error).message);
    }
  };

  const copyText = async () => {
    if (!warlord) return;
    try {
      await navigator.clipboard.writeText(warlordToText(warlord));
      toast("success", "テキストをコピーしました");
    } catch {
      toast("error", "コピーできませんでした");
    }
  };

  const view = warlord && !editing ? warlord : null;
  const gallery = view ? view.gallery_images : draft.gallery_images;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="panel scroll-thin relative flex max-h-[calc(100dvh-env(safe-area-inset-top)-0.5rem)] w-full max-w-5xl flex-col overflow-hidden rounded-b-none pb-[env(safe-area-inset-bottom)] sm:max-h-[94vh] sm:rounded-xl sm:pb-0"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* ヘッダー */}
        <div
          className={`border-b px-4 py-3 sm:px-5 sm:py-4 ${
            (view ?? draft).is_special ? "border-gold-600/50 bg-gradient-to-r from-gold-700/25 to-transparent" : "border-ebony-700"
          }`}
        >
          <div className="min-w-0">
            {view ? (
              <>
                <div className="flex items-center gap-2">
                  <RarityBadge rarity={view.rarity} size="md" />
                  <button
                    onClick={toggleSpecial}
                    className="flex shrink-0 items-center gap-1 rounded-full border border-ebony-600 px-2.5 py-1 text-xs whitespace-nowrap text-ash hover:border-gold-500 hover:text-gold-300 sm:text-sm"
                  >
                    <Sparkles className="size-4" /> {view.is_special ? "通常に変更" : "特異に変更"}
                  </button>
                  <div className="ml-auto flex items-center gap-0.5 sm:gap-1.5">
                    <IconButton title="テキストをコピー" onClick={copyText}>
                      <Copy className="size-4" />
                    </IconButton>
                    <IconButton title="編集" onClick={() => setEditing(true)}>
                      <Pencil className="size-4" />
                    </IconButton>
                    <button
                      onClick={remove}
                      className="flex shrink-0 items-center gap-1 rounded-xl border border-hi-600/70 bg-hi-800/30 px-2.5 py-1.5 text-sm font-bold whitespace-nowrap text-hi-400"
                    >
                      <Trash2 className="size-4" /> 消去
                    </button>
                    <IconButton title="閉じる" onClick={onClose}>
                      <X className="size-5" />
                    </IconButton>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                  {view.is_special && <SpecialBadge size="md" />}
                  <h2 className="font-serif text-3xl font-extrabold">{view.name}</h2>
                  {view.faction && <span className="rounded-lg bg-ebony-700 px-3 py-1 text-sm">{view.faction}</span>}
                  <span className="font-mono text-lg font-bold text-shu-300">
                    {view.level > 0 && `Lv.${view.level} `}
                    {view.stars > 0 && <span className="text-base">★{view.stars}</span>}
                  </span>
                </div>
                <div className="mt-2.5 flex flex-wrap items-center gap-2 text-sm">
                  <span className="flex items-center gap-1.5 rounded-full border border-emerald-700/70 bg-emerald-900/30 px-3 py-1 text-emerald-300">
                    <Camera className="size-4" /> {view.screenshot_count}枚統合
                  </span>
                  {view.title_alias && <span className="rounded-full border border-ebony-600 px-3 py-1 text-gold-400">「{view.title_alias}」</span>}
                </div>
                <div className="mt-2.5 flex flex-wrap items-center gap-2 text-sm">
                  <label
                    className={`flex cursor-pointer items-center gap-1.5 rounded-lg bg-gradient-to-b from-shu-400 to-shu-600 px-3 py-1.5 font-bold text-white ${adding ? "opacity-50" : ""}`}
                  >
                    {adding ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />} スクショを追加して統合
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      hidden
                      disabled={adding}
                      onChange={(e) => {
                        void addScreenshots(e.target.files);
                        e.target.value = "";
                      }}
                    />
                  </label>
                  {view.gallery_images.length > 0 && (
                    <button onClick={reanalyze} className="flex items-center gap-1.5 rounded-lg border border-ebony-600 px-3 py-1.5 text-ash hover:text-washi">
                      <RotateCcw className="size-4" /> 登録画像を再解析
                    </button>
                  )}
                  {view.gallery_images.length > 0 && (
                    <button onClick={rebuild} className="flex items-center gap-1.5 rounded-lg border border-hi-600/60 px-3 py-1.5 text-hi-400">
                      <Split className="size-4" /> 情報が混ざった時: 画像から作り直す
                    </button>
                  )}
                  {allWarlords.length > 1 && (
                    <button
                      onClick={() => setMergeOpen((v) => !v)}
                      className="flex items-center gap-1.5 rounded-lg border border-ebony-600 px-3 py-1.5 text-ash hover:text-washi"
                    >
                      <Merge className="size-4" /> 別の武将に分かれた時: まとめる
                    </button>
                  )}
                  {pendingCount > 0 && (
                    <span className="flex items-center gap-1.5 text-xs text-gold-300">
                      <Loader2 className="size-3.5 animate-spin" /> この武将に統合する解析が残り {pendingCount} 枚
                    </span>
                  )}
                </div>
                {mergeOpen && (
                  <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg border border-ebony-700 bg-ebony-900 p-2.5 text-sm">
                    <span className="text-xs text-ash">この武将にまとめる武将:</span>
<div className="min-w-0 flex-1">
                      <WarlordPicker
                        warlords={mergeCandidates.map(({ w }) => w)}
                        value={mergeId}
                        onChange={setMergeId}
                        placeholder="まとめる武将を検索"
                        priority={(w) => mergeCandidates.find((c) => c.w.id === w.id)?.near ?? 2}
                        suggest={(w) => (mergeCandidates.find((c) => c.w.id === w.id)?.near ?? 2) < 2}
                      />
                    </div>
                    <button
                      disabled={!mergeId}
                      onClick={mergeOther}
                      className="rounded-lg bg-gradient-to-b from-shu-400 to-shu-600 px-3 py-1.5 font-bold text-white disabled:opacity-40"
                    >
                      まとめる
                    </button>
                    <span className="w-full text-[11px] text-ebony-500">同じ名前・1 文字違いの武将は、検索しなくても候補に出ます。まとめた後も、この武将の通常/特異はそのままです。</span>
                  </div>
                )}
              </>
            ) : (
              <div className="flex items-center gap-2">
                <h2 className="font-serif text-xl font-bold text-gold-400">{warlord ? "武将データを編集" : "武将を手動登録"}</h2>
                <div className="ml-auto flex items-center gap-1">
                  {warlord && (
                    <button onClick={() => (setEditing(false), setDraft(toInput(warlord)), setOriginal(toInput(warlord)), setUpdatedWhileEditing(false))} className="rounded-md px-3 py-1.5 text-sm text-ash hover:text-washi">
                      キャンセル
                    </button>
                  )}
                  <button
                    onClick={save}
                    disabled={saving}
                    className="flex items-center gap-1 rounded-md bg-gradient-to-b from-shu-400 to-shu-600 px-3 py-1.5 text-sm font-bold text-white disabled:opacity-50"
                  >
                    <Save className="size-4" /> 保存
                  </button>
                  <IconButton title="閉じる" onClick={onClose}>
                    <X className="size-5" />
                  </IconButton>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="scroll-thin flex-1 overflow-y-auto p-5">
          {view ? (
            <DetailView w={view} counterpart={counterpart} allWarlords={allWarlords} onOpenOther={onOpenOther} />
          ) : (
            <>
              {updatedWhileEditing && (
                <p className="mb-4 rounded-lg border border-amber-500/50 bg-amber-900/20 p-3 text-xs text-amber-200">
                  編集中に、この武将へ解析結果が統合されました。保存すると、あなたが変えた項目だけが書き換わり、解析で入った内容は残ります。
                </p>
              )}
              <EditForm draft={draft} setDraft={setDraft} />
            </>
          )}

          {!warlord && <NewScreenshots files={newFiles} setFiles={setNewFiles} analyze={analyzeNew} setAnalyze={setAnalyzeNew} />}

          {/* ギャラリー */}
          {(warlord || gallery.length > 0) && (
          <Section title={`スクリーンショット (${gallery.length})`}>
            {gallery.length === 0 ? (
              <p className="text-sm text-ebony-500">画像はありません</p>
            ) : (
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-6">
                {gallery.map((url, i) => (
                  <div key={url} className="group relative">
                    <button
                      onClick={() => setLightbox(i)}
                      className={`block aspect-[9/16] w-full overflow-hidden rounded-md border ${
                        url === (view ?? draft).image_url ? "border-gold-500" : "border-ebony-700"
                      }`}
                    >
                      <StoredImage id={url} alt="" className="size-full object-cover transition group-hover:scale-105" />
                    </button>
                    {!view && (
                      <div className="absolute inset-x-1 bottom-1 flex justify-between">
                        <button
                          onClick={() => setDraft((d) => ({ ...d, image_url: url }))}
                          className="rounded bg-ebony-950/85 px-1.5 py-0.5 text-[10px] text-gold-300"
                        >
                          代表に
                        </button>
                        <button
                          onClick={() =>
                            setDraft((d) => {
                              const rest = d.gallery_images.filter((u) => u !== url);
                              return { ...d, gallery_images: rest, image_url: d.image_url === url ? rest[0] ?? "" : d.image_url };
                            })
                          }
                          className="rounded bg-ebony-950/85 p-1 text-hi-400"
                          aria-label="画像を削除"
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Section>
          )}
        </div>
      </div>

      {lightbox !== null && gallery[lightbox] && (
        <Lightbox images={gallery} index={lightbox} onChange={setLightbox} onClose={() => setLightbox(null)} />
      )}
    </div>
  );
}

/** 手動登録の時に添えるスクショの選択 */
function NewScreenshots({
  files,
  setFiles,
  analyze,
  setAnalyze,
}: {
  files: File[];
  setFiles: (f: File[]) => void;
  analyze: boolean;
  setAnalyze: (v: boolean) => void;
}) {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const list = files.map((f) => URL.createObjectURL(f));
    setUrls(list);
    return () => list.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);
  return (
    <Section title={`スクリーンショットを添える (${files.length})`}>
      <label className="flex w-fit cursor-pointer items-center gap-1.5 rounded-lg bg-gradient-to-b from-shu-400 to-shu-600 px-3 py-1.5 text-sm font-bold text-white">
        <ImagePlus className="size-4" /> 画像を選ぶ (複数可)
        <input
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith("image/") || /\.(jpe?g|png|heic|heif|webp)$/i.test(f.name));
            setFiles([...files, ...picked]);
            e.target.value = "";
          }}
        />
      </label>
      {files.length > 0 && (
        <>
          <div className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-6">
            {urls.map((u, i) => (
              <div key={u} className="relative">
                <img src={u} alt="" className="aspect-[9/16] w-full rounded-md border border-ebony-700 object-cover" />
                <button
                  onClick={() => setFiles(files.filter((_, j) => j !== i))}
                  className="absolute right-1 bottom-1 rounded bg-ebony-950/85 p-1 text-hi-400"
                  aria-label="画像を外す"
                >
                  <Trash2 className="size-3" />
                </button>
              </div>
            ))}
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={analyze} onChange={(e) => setAnalyze(e.target.checked)} className="accent-gold-500" />
            保存した後、AI で解析して空欄を埋める
          </label>
          <p className="mt-1 text-[11px] text-ebony-500">
            {analyze
              ? "画像はこの武将に統合されます (別の武将として登録されることはありません)。入力した内容は上書きされません。"
              : "解析せず、画像だけをこの武将に登録します。"}
          </p>
        </>
      )}
    </Section>
  );
}

/** 編集前と比べて変わった項目だけを取り出す */
function changedFields(before: WarlordInput, after: WarlordInput): Partial<WarlordInput> {
  const out: Partial<WarlordInput> = {};
  for (const key of Object.keys(after) as (keyof WarlordInput)[]) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) (out as Record<string, unknown>)[key] = after[key];
  }
  return out;
}

function IconButton({ children, title, onClick, danger }: { children: ReactNode; title: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`rounded-md p-1.5 text-ash sm:p-2 transition hover:bg-ebony-700 ${danger ? "hover:text-hi-400" : "hover:text-washi"}`}
    >
      {children}
    </button>
  );
}

function Section({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-6 last:mb-0">
      <h3 className="mb-3 flex items-center gap-2 border-b border-ebony-700 pb-1.5 font-serif text-sm font-bold tracking-wider text-gold-400">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

function Empty({ children = "未解析" }: { children?: ReactNode }) {
  return <p className="text-sm text-ebony-500">{children}</p>;
}

// ---------------- 表示 ----------------

const STAT_GRID = [
  { key: "attack", label: "攻", color: "text-hi-400" },
  { key: "stratagem", label: "計", color: "text-violet-400" },
  { key: "defense", label: "防", color: "text-sky-400" },
  { key: "troops", label: "兵", color: "text-emerald-400" },
] as const;

function DetailView({
  w,
  counterpart,
  allWarlords,
  onOpenOther,
}: {
  w: Warlord;
  counterpart?: Warlord;
  allWarlords: Warlord[];
  onOpenOther: (id: string) => void;
}) {
  return (
    <>
      {counterpart && (
        <button
          onClick={() => onOpenOther(counterpart.id)}
          className="mb-5 flex w-full items-center gap-2 rounded-lg border border-ebony-700 bg-ebony-900 px-3 py-2 text-left text-xs text-ash hover:border-gold-600"
        >
          {counterpart.is_special ? <SpecialBadge /> : <span className="rounded bg-ebony-700 px-1.5 py-0.5 text-[10px]">通常</span>}
          {counterpart.is_special ? "特異" : "通常"}版の {counterpart.name} も登録されています (別データ) →
        </button>
      )}

      <div className="mb-5 rounded-2xl border border-ebony-700 bg-ebony-950/60 p-4 sm:p-5">
        <div className="flex items-baseline justify-between gap-2">
          <p className="font-serif text-lg font-extrabold text-shu-300">成長値：{w.growth_total || "—"}</p>
          <span className="text-xs text-ash">基礎数値 & 成長比率</span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          {STAT_GRID.map(({ key, label, color }) => (
            <div key={key} className="flex items-center justify-between rounded-xl border border-ebony-700 bg-ebony-900 px-4 py-3">
              <span className={`font-serif font-bold ${color}`}>{label}</span>
              <span className="text-right tabular-nums">
                <span className="text-xl font-extrabold">{w[`${key}_base`] || "—"}</span>
                {w[`${key}_growth`] && <span className="ml-2 text-sm text-ash">({w[`${key}_growth`]})</span>}
              </span>
            </div>
          ))}
        </div>
        {(w.troop_type || w.troop_variants.length > 0) && (
          <div className="mt-4 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-ash">兵種</span>
            {(w.troop_variants.length ? w.troop_variants : [w.troop_type]).map((t) => (
              <span
                key={t}
                className={`rounded border px-2 py-0.5 ${t === w.troop_type ? "border-shu-400 text-shu-300" : "border-ebony-600 text-ash"}`}
              >
                {t}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="mb-5 rounded-2xl border border-ebony-700 bg-ebony-950/60 p-4 sm:p-5">
        <h3 className="flex items-center gap-2 font-serif text-base font-extrabold text-shu-300">
          <Sparkles className="size-5" />
          奥義スキル{w.skill_gauge > 0 && `（奥義ゲージ${w.skill_gauge}）`}
        </h3>
        {w.skill_name || w.skill_desc ? (
          <>
            <p className="mt-2 text-lg font-bold">{w.skill_name || "名称未解析"}</p>
            <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-washi/80">{w.skill_desc || "効果未解析"}</p>
          </>
        ) : (
          <p className="mt-2 text-sm text-ebony-500">未解析</p>
        )}
      </div>

      <div className="mb-6 rounded-2xl border border-ebony-700 bg-ebony-950/60 p-4 sm:p-5">
        <h3 className="flex flex-wrap items-center gap-2 font-serif text-base font-extrabold text-shu-300">
          <Swords className="size-5" />
          覚醒スキル{w.awakening_priority && `（${w.awakening_priority}）`}
          {w.has_weapon_awakening && <WeaponBadge />}
        </h3>
        {w.has_awakening ? (
          <>
            <p className="mt-2 text-lg font-bold">{w.awakening_skill_name || "名称未解析"}</p>
            <div className={`mt-2 grid gap-3 ${w.has_weapon_awakening ? "md:grid-cols-2" : ""}`}>
              <div className={w.has_weapon_awakening ? "rounded-xl border border-ebony-700 bg-ebony-900 p-3" : ""}>
                {w.has_weapon_awakening && <p className="mb-1 text-[11px] font-bold tracking-wider text-ash">武器覚醒前</p>}
                <p className="text-sm leading-relaxed whitespace-pre-wrap text-washi/80">
                  {w.awakening_before_weapon || <span className="text-ebony-500">効果未解析</span>}
                </p>
              </div>
              {w.has_weapon_awakening && (
                <div className="rounded-xl border border-hi-500/50 bg-gradient-to-br from-hi-800/40 to-ebony-900 p-3">
                  <p className="mb-1 flex items-center gap-1 text-[11px] font-bold tracking-wider text-hi-400">
                    <Swords className="size-3" /> 専用武器覚醒後
                  </p>
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">
                    {w.awakening_after_weapon || <span className="text-ebony-500">未解析</span>}
                  </p>
                </div>
              )}
            </div>
          </>
        ) : (
          <p className="mt-2 text-sm text-ebony-500">未解析</p>
        )}
      </div>

      <Section title="天賦">
        {w.talents.length ? (
          <ol className="relative space-y-2 border-l border-ebony-700 pl-5">
            {w.talents.map((t, i) => (
              <li key={i} className="relative">
                <span
                  className={`absolute top-3 -left-[1.6rem] grid size-4 place-items-center rounded-full border ${
                    t.unlocked ? "border-gold-400 bg-gold-500" : "border-ebony-500 bg-ebony-800"
                  }`}
                />
                <div className={`rounded-lg border p-3 ${t.unlocked ? "border-gold-700/60 bg-ebony-900" : "border-ebony-800 bg-ebony-900/50 opacity-70"}`}>
                  <div className="mb-0.5 flex flex-wrap items-center gap-2">
                    <Stars count={t.star_level} className="text-xs" />
                    <span className="font-bold">{t.name || t.effect || "未解析"}</span>
                    {t.position && <span className="text-[11px] text-ash">{t.position}</span>}
                    <span className={`ml-auto flex items-center gap-0.5 text-[11px] ${t.unlocked ? "text-gold-400" : "text-ebony-500"}`}>
                      {t.unlocked ? <Unlock className="size-3" /> : <Lock className="size-3" />}
                      {t.unlocked ? "解放済" : "未解放"}
                    </span>
                  </div>
                  {t.name && t.effect && <p className="text-sm text-ash">{t.effect}</p>}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <Empty />
        )}
      </Section>

      <Section title="連携スキル" icon={<Users className="size-4" />}>
        {w.synergy_skills.length ? (
          <div className="grid gap-2 md:grid-cols-2">
            {w.synergy_skills.map((s, i) => {
              const partners = allWarlords.filter((p) => p.name === s.partner);
              return (
                <div key={i} className="rounded-lg border border-ebony-700 bg-ebony-900 p-3">
                  <div className="mb-1 flex items-center gap-2">
                    <span className="font-bold text-gold-300">{s.partner}</span>
                    {partners.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => onOpenOther(p.id)}
                        className="rounded border border-ebony-600 px-1.5 text-[10px] text-ash hover:border-gold-500 hover:text-gold-300"
                      >
                        {p.is_special ? "特異" : "通常"}を見る
                      </button>
                    ))}
                  </div>
                  <p className="text-sm text-ash">{s.effect}</p>
                </div>
              );
            })}
          </div>
        ) : (
          <Empty />
        )}
      </Section>
    </>
  );
}

// ---------------- 編集 ----------------

function EditForm({ draft, setDraft }: { draft: WarlordInput; setDraft: (fn: (d: WarlordInput) => WarlordInput) => void }) {
  const set = <K extends keyof WarlordInput>(key: K, value: WarlordInput[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const num = (v: string) => (v === "" ? 0 : Number(v));

  const updateTalent = (i: number, patch: Partial<Talent>) =>
    setDraft((d) => ({ ...d, talents: d.talents.map((t, idx) => (idx === i ? { ...t, ...patch } : t)) }));

  return (
    <>
      <Section title="基本情報">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="武将名 *">
            <input className="field" value={draft.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field label="二つ名">
            <input className="field" value={draft.title_alias} onChange={(e) => set("title_alias", e.target.value)} />
          </Field>
          <Field label="レアリティ">
            <select className="field" value={draft.rarity} onChange={(e) => set("rarity", e.target.value as WarlordInput["rarity"])}>
              <option value="">—</option>
              {RARITIES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </Field>
          <Field label="勢力">
            <select className="field" value={draft.faction} onChange={(e) => set("faction", e.target.value as WarlordInput["faction"])}>
              <option value="">—</option>
              {FACTIONS.map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </Field>
          <Field label="Lv">
            <input type="number" min={0} className="field" value={draft.level || ""} onChange={(e) => set("level", num(e.target.value))} />
          </Field>
          <Field label="星 (0〜5)">
            <input type="number" min={0} max={5} className="field" value={draft.stars} onChange={(e) => set("stars", num(e.target.value))} />
          </Field>
          <Field label="区分">
            <label
              className={`flex h-[2.2rem] cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm ${
                draft.is_special ? "border-gold-500 bg-gold-500/10 text-gold-300" : "border-ebony-600"
              }`}
            >
              <input type="checkbox" checked={draft.is_special} onChange={(e) => set("is_special", e.target.checked)} className="accent-gold-500" />
              特異武将
            </label>
          </Field>
          <Field label="成長値合計">
            <input className="field" value={draft.growth_total} onChange={(e) => set("growth_total", e.target.value)} placeholder="9" />
          </Field>
        </div>
      </Section>

      <Section title="成長値 (基礎値 / 成長率)">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {STATS.map(({ key, label }) => (
            <div key={key} className="flex items-end gap-2">
              <Field label={`${label} 基礎値`}>
                <input
                  type="number"
                  className="field"
                  value={draft[`${key}_base`] || ""}
                  onChange={(e) => set(`${key}_base`, num(e.target.value))}
                />
              </Field>
              <Field label="成長率">
                <input className="field" value={draft[`${key}_growth`]} placeholder="+2.6" onChange={(e) => set(`${key}_growth`, e.target.value)} />
              </Field>
            </div>
          ))}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="現在の兵種">
            <input className="field" value={draft.troop_type} onChange={(e) => set("troop_type", e.target.value)} />
          </Field>
          <Field label="選択可能な兵種 (読点・カンマ区切り)">
            <ListInput value={draft.troop_variants} onChange={(v) => set("troop_variants", v)} />
          </Field>
        </div>
      </Section>

      <Section title="奥義スキル">
        <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
          <Field label="スキル名">
            <input className="field" value={draft.skill_name} onChange={(e) => set("skill_name", e.target.value)} />
          </Field>
          <Field label="ゲージ">
            <select className="field" value={draft.skill_gauge} onChange={(e) => set("skill_gauge", Number(e.target.value))}>
              {[0, 1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n || "—"}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="効果" className="mt-3">
          <textarea rows={3} className="field" value={draft.skill_desc} onChange={(e) => set("skill_desc", e.target.value)} />
        </Field>
      </Section>

      <Section title="覚醒スキル">
        <div className="grid gap-3 sm:grid-cols-[1fr_8rem_auto_auto]">
          <Field label="覚醒スキル名">
            <input className="field" value={draft.awakening_skill_name} onChange={(e) => set("awakening_skill_name", e.target.value)} />
          </Field>
          <Field label="優先度">
            <select className="field" value={draft.awakening_priority} onChange={(e) => set("awakening_priority", e.target.value)}>
              <option value="">—</option>
              {[...AWAKENING_PRIORITIES, ...(draft.awakening_priority && !AWAKENING_PRIORITIES.includes(draft.awakening_priority) ? [draft.awakening_priority] : [])].map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input type="checkbox" checked={draft.has_awakening} onChange={(e) => set("has_awakening", e.target.checked)} className="accent-gold-500" />
            覚醒あり
          </label>
          <label className="flex items-center gap-2 self-end pb-2 text-sm text-hi-400">
            <input
              type="checkbox"
              checked={draft.has_weapon_awakening}
              onChange={(e) => set("has_weapon_awakening", e.target.checked)}
              className="accent-hi-500"
            />
            専用武器覚醒あり
          </label>
        </div>
        <div className={`mt-3 grid gap-3 ${draft.has_weapon_awakening ? "md:grid-cols-2" : ""}`}>
          <Field label={draft.has_weapon_awakening ? "武器覚醒前の効果" : "覚醒効果"}>
            <textarea rows={3} className="field" value={draft.awakening_before_weapon} onChange={(e) => set("awakening_before_weapon", e.target.value)} />
          </Field>
          {draft.has_weapon_awakening && (
            <Field label="武器覚醒後の効果">
              <textarea rows={3} className="field" value={draft.awakening_after_weapon} onChange={(e) => set("awakening_after_weapon", e.target.value)} />
            </Field>
          )}
        </div>
      </Section>

      <Section title="天賦">
        <div className="space-y-2">
          {draft.talents.map((t, i) => (
            <div key={i} className="grid items-end gap-2 rounded-lg border border-ebony-700 p-2 sm:grid-cols-[5rem_6rem_1fr_2fr_auto_auto]">
              <Field label="星">
                <select className="field" value={t.star_level} onChange={(e) => updateTalent(i, { star_level: Number(e.target.value) })}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      星{n}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="位置">
                <input className="field" value={t.position} onChange={(e) => updateTalent(i, { position: e.target.value })} />
              </Field>
              <Field label="名称">
                <input className="field" value={t.name} onChange={(e) => updateTalent(i, { name: e.target.value })} />
              </Field>
              <Field label="効果">
                <input className="field" value={t.effect} onChange={(e) => updateTalent(i, { effect: e.target.value })} />
              </Field>
              <label className="flex items-center gap-1 pb-2 text-xs">
                <input type="checkbox" checked={t.unlocked} onChange={(e) => updateTalent(i, { unlocked: e.target.checked })} className="accent-gold-500" />
                解放
              </label>
              <button
                onClick={() => setDraft((d) => ({ ...d, talents: d.talents.filter((_, idx) => idx !== i) }))}
                className="mb-1 rounded p-1.5 text-ash hover:text-hi-400"
                aria-label="天賦を削除"
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
          <AddButton
            onClick={() =>
              setDraft((d) => ({
                ...d,
                talents: [...d.talents, { star_level: Math.min(5, d.talents.length + 1), position: "", name: "", effect: "", unlocked: false }],
              }))
            }
          >
            天賦を追加
          </AddButton>
        </div>
      </Section>

      <Section title="連携スキル">
        <div className="space-y-2">
          {draft.synergy_skills.map((s, i) => (
            <div key={i} className="grid items-end gap-2 rounded-lg border border-ebony-700 p-2 sm:grid-cols-[12rem_1fr_auto]">
              <Field label="相手武将">
                <input
                  className="field"
                  value={s.partner}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      synergy_skills: d.synergy_skills.map((x, idx) => (idx === i ? { ...x, partner: e.target.value } : x)),
                    }))
                  }
                />
              </Field>
              <Field label="効果">
                <input
                  className="field"
                  value={s.effect}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      synergy_skills: d.synergy_skills.map((x, idx) => (idx === i ? { ...x, effect: e.target.value } : x)),
                    }))
                  }
                />
              </Field>
              <button
                onClick={() => setDraft((d) => ({ ...d, synergy_skills: d.synergy_skills.filter((_, idx) => idx !== i) }))}
                className="mb-1 rounded p-1.5 text-ash hover:text-hi-400"
                aria-label="連携を削除"
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
          <AddButton onClick={() => setDraft((d) => ({ ...d, synergy_skills: [...d.synergy_skills, { partner: "", effect: "" }] }))}>
            連携スキルを追加
          </AddButton>
        </div>
      </Section>
    </>
  );
}

function Field({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`block min-w-0 flex-1 ${className}`}>
      <span className="mb-1 block text-[11px] font-bold tracking-wider text-ash">{label}</span>
      {children}
    </label>
  );
}

/** 区切り文字を打ち込めるよう、入力中は文字列のまま保持し、確定時に配列化する */
function ListInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(value.join("、"));
  const commit = () => onChange(text.split(/[、,，]/).map((s) => s.trim()).filter(Boolean));
  return <input className="field" value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} />;
}

function AddButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 rounded-md border border-dashed border-ebony-600 px-3 py-1.5 text-xs text-ash hover:border-gold-600 hover:text-gold-300"
    >
      <Plus className="size-3.5" /> {children}
    </button>
  );
}

// ---------------- ライトボックス ----------------

function Lightbox({ images, index, onChange, onClose }: { images: string[]; index: number; onChange: (i: number) => void; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") onChange((index + 1) % images.length);
      if (e.key === "ArrowLeft") onChange((index - 1 + images.length) % images.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, images.length, onChange, onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/95"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <StoredImage id={images[index]} alt="" className="max-h-[85vh] max-w-[94vw] rounded object-contain shadow-2xl" onClick={(e) => e.stopPropagation()} />
      <button className="absolute top-4 right-4 rounded-full bg-ebony-800/80 p-2 text-washi" onClick={onClose} aria-label="閉じる">
        <X className="size-5" />
      </button>
      {images.length > 1 && (
        <>
          <button
            className="absolute left-3 rounded-full bg-ebony-800/80 p-2 text-washi"
            onClick={(e) => {
              e.stopPropagation();
              onChange((index - 1 + images.length) % images.length);
            }}
            aria-label="前の画像"
          >
            <ChevronLeft className="size-6" />
          </button>
          <button
            className="absolute right-3 rounded-full bg-ebony-800/80 p-2 text-washi"
            onClick={(e) => {
              e.stopPropagation();
              onChange((index + 1) % images.length);
            }}
            aria-label="次の画像"
          >
            <ChevronRight className="size-6" />
          </button>
          <span className="absolute bottom-4 rounded-full bg-ebony-800/80 px-3 py-1 text-xs text-washi">
            {index + 1} / {images.length}
          </span>
        </>
      )}
    </div>
  );
}
