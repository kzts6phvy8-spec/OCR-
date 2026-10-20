import { useEffect, useState, type ReactNode } from "react";
import {
  ChevronLeft,
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
  type Talent,
  type Warlord,
  type WarlordInput,
} from "../../shared/types.ts";
import { api } from "../lib/api.ts";
import { useToast } from "../lib/toast.tsx";
import { RarityBadge, SpecialBadge, Stars, WeaponBadge } from "./Badges.tsx";

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

  useEffect(() => {
    setEditing(warlord === null);
    setDraft(warlord ? toInput(warlord) : structuredClone(EMPTY));
  }, [warlord?.id, warlord?.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && lightbox === null) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox, onClose]);

  const counterpart = warlord
    ? allWarlords.find((w) => w.name === warlord.name && w.is_special !== warlord.is_special)
    : undefined;

  const save = async () => {
    if (!draft.name.trim()) return toast("error", "武将名を入力してください");
    setSaving(true);
    try {
      const saved = warlord ? await api.updateWarlord(warlord.id, draft) : await api.createWarlord(draft);
      toast("success", "保存しました", saved.name);
      setEditing(false);
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

  const view = warlord && !editing ? warlord : null;
  const gallery = view ? view.gallery_images : draft.gallery_images;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="panel scroll-thin relative flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-b-none sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* ヘッダー */}
        <div
          className={`flex items-start gap-3 border-b px-5 py-4 ${
            (view ?? draft).is_special ? "border-gold-600/50 bg-gradient-to-r from-gold-700/25 to-transparent" : "border-ebony-700"
          }`}
        >
          <div className="min-w-0 flex-1">
            {view ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <RarityBadge rarity={view.rarity} />
                  {view.is_special && <SpecialBadge size="md" />}
                  <h2 className="font-serif text-2xl font-extrabold">{view.name}</h2>
                  {view.has_weapon_awakening && <WeaponBadge />}
                </div>
                <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ash">
                  {view.title_alias && <span className="text-gold-400">「{view.title_alias}」</span>}
                  {view.faction && <span>{view.faction}</span>}
                  {view.level > 0 && <span>Lv.{view.level}</span>}
                  <Stars count={view.stars} />
                  <span>{view.screenshot_count} 枚のスクショから解析</span>
                </p>
              </>
            ) : (
              <h2 className="font-serif text-xl font-bold text-gold-400">{warlord ? "武将データを編集" : "武将を手動登録"}</h2>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {view ? (
              <>
                <IconButton title="編集" onClick={() => setEditing(true)}>
                  <Pencil className="size-4" />
                </IconButton>
                <IconButton title="削除" onClick={remove} danger>
                  <Trash2 className="size-4" />
                </IconButton>
              </>
            ) : (
              <>
                {warlord && (
                  <button onClick={() => (setEditing(false), setDraft(toInput(warlord)))} className="rounded-md px-3 py-1.5 text-sm text-ash hover:text-washi">
                    キャンセル
                  </button>
                )}
                <button
                  onClick={save}
                  disabled={saving}
                  className="flex items-center gap-1 rounded-md bg-gradient-to-b from-gold-500 to-gold-600 px-3 py-1.5 text-sm font-bold text-ebony-950 disabled:opacity-50"
                >
                  <Save className="size-4" /> 保存
                </button>
              </>
            )}
            <IconButton title="閉じる" onClick={onClose}>
              <X className="size-5" />
            </IconButton>
          </div>
        </div>

        <div className="scroll-thin flex-1 overflow-y-auto p-5">
          {view ? (
            <DetailView w={view} counterpart={counterpart} allWarlords={allWarlords} onOpenOther={onOpenOther} />
          ) : (
            <EditForm draft={draft} setDraft={setDraft} />
          )}

          {/* ギャラリー */}
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
                      <img src={url} alt="" loading="lazy" className="size-full object-cover transition group-hover:scale-105" />
                    </button>
                    {!view && (
                      <div className="absolute inset-x-1 bottom-1 flex justify-between opacity-0 transition group-hover:opacity-100">
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
        </div>
      </div>

      {lightbox !== null && gallery[lightbox] && (
        <Lightbox images={gallery} index={lightbox} onChange={setLightbox} onClose={() => setLightbox(null)} />
      )}
    </div>
  );
}

function IconButton({ children, title, onClick, danger }: { children: ReactNode; title: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`rounded-md p-2 text-ash transition hover:bg-ebony-700 ${danger ? "hover:text-hi-400" : "hover:text-washi"}`}
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
  const growthMax = 3.5;
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

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="成長値">
          <div className="mb-3 flex items-baseline gap-2">
            <span className="text-xs text-ash">合計</span>
            <span className="gold-text font-serif text-3xl font-extrabold">{w.growth_total || "—"}</span>
          </div>
          <div className="space-y-2.5">
            {STATS.map(({ key, label, color }) => {
              const base = w[`${key}_base`];
              const growth = w[`${key}_growth`];
              const g = parseFloat(growth.replace("+", "")) || 0;
              return (
                <div key={key} className="flex items-center gap-3">
                  <span className="w-5 font-serif font-bold text-washi">{label}</span>
                  <span className="w-12 text-right text-sm tabular-nums text-ash">{base || "—"}</span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-ebony-800">
                    <div className={`h-full rounded-full bg-gradient-to-r ${color}`} style={{ width: `${Math.min(100, (g / growthMax) * 100)}%` }} />
                  </div>
                  <span className="w-12 text-right text-sm font-bold tabular-nums text-gold-300">{growth || "—"}</span>
                </div>
              );
            })}
          </div>
          {(w.troop_type || w.troop_variants.length > 0) && (
            <div className="mt-4 flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-ash">兵種</span>
              {(w.troop_variants.length ? w.troop_variants : [w.troop_type]).map((t) => (
                <span
                  key={t}
                  className={`rounded border px-2 py-0.5 ${t === w.troop_type ? "border-gold-500 text-gold-300" : "border-ebony-600 text-ash"}`}
                >
                  {t}
                </span>
              ))}
            </div>
          )}
        </Section>

        <Section title="奥義スキル" icon={<Sparkles className="size-4" />}>
          {w.skill_name ? (
            <div className="rounded-lg border border-ebony-700 bg-ebony-900 p-3">
              <div className="mb-1 flex items-center justify-between">
                <p className="font-serif text-lg font-bold">『{w.skill_name}』</p>
                {w.skill_gauge > 0 && (
                  <span className="flex gap-0.5" title={`ゲージ ${w.skill_gauge}`}>
                    {Array.from({ length: 3 }, (_, i) => (
                      <span key={i} className={`h-3 w-5 rounded-sm ${i < w.skill_gauge ? "bg-gradient-to-b from-gold-300 to-gold-600" : "bg-ebony-700"}`} />
                    ))}
                  </span>
                )}
              </div>
              <p className="text-sm leading-relaxed whitespace-pre-wrap text-ash">{w.skill_desc || "効果未解析"}</p>
            </div>
          ) : (
            <Empty />
          )}
        </Section>
      </div>

      <Section title="覚醒スキル" icon={<Swords className="size-4" />}>
        {w.has_awakening ? (
          <>
            <div className="mb-3 flex items-center gap-2">
              <p className="font-serif text-lg font-bold">『{w.awakening_skill_name || "名称未解析"}』</p>
              {w.awakening_priority && (
                <span className="rounded border border-hi-500/60 bg-hi-800/50 px-2 py-0.5 text-[11px] font-bold text-hi-400">
                  優先度 {w.awakening_priority}
                </span>
              )}
            </div>
            <div className={`grid gap-3 ${w.has_weapon_awakening ? "md:grid-cols-2" : ""}`}>
              <div className="rounded-lg border border-ebony-700 bg-ebony-900 p-3">
                <p className="mb-1 text-[11px] font-bold tracking-wider text-ash">{w.has_weapon_awakening ? "武器覚醒前" : "覚醒効果"}</p>
                <p className="text-sm leading-relaxed whitespace-pre-wrap">{w.awakening_before_weapon || <span className="text-ebony-500">未解析</span>}</p>
              </div>
              {w.has_weapon_awakening && (
                <div className="rounded-lg border border-hi-500/50 bg-gradient-to-br from-hi-800/40 to-ebony-900 p-3">
                  <p className="mb-1 flex items-center gap-1 text-[11px] font-bold tracking-wider text-hi-400">
                    <Swords className="size-3" /> 専用武器覚醒後
                  </p>
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">
                    {w.awakening_after_weapon || <span className="text-ebony-500">未解析</span>}
                  </p>
                </div>
              )}
            </div>
            {!w.has_weapon_awakening && w.is_special && <p className="mt-2 text-[11px] text-ebony-500">この特異武将には専用武器覚醒が登録されていません</p>}
          </>
        ) : (
          <Empty />
        )}
      </Section>

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
                    <span className="font-bold">{t.name || "名称未解析"}</span>
                    {t.position && <span className="text-[11px] text-ash">{t.position}</span>}
                    <span className={`ml-auto flex items-center gap-0.5 text-[11px] ${t.unlocked ? "text-gold-400" : "text-ebony-500"}`}>
                      {t.unlocked ? <Unlock className="size-3" /> : <Lock className="size-3" />}
                      {t.unlocked ? "解放済" : "未解放"}
                    </span>
                  </div>
                  <p className="text-sm text-ash">{t.effect}</p>
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
        {draft.is_special && (
          <p className="mt-2 text-[11px] text-amber-300/80">特異武将は通常武将とは別データとして保存されます。通常武将の武器覚醒を流用しないでください。</p>
        )}
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
              {AWAKENING_PRIORITIES.map((p) => (
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
      <img src={images[index]} alt="" className="max-h-[92vh] max-w-[92vw] rounded object-contain shadow-2xl" onClick={(e) => e.stopPropagation()} />
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
