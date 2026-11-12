import { useEffect, useMemo, useState } from "react";
import { Crown, Download, Sparkles } from "lucide-react";
import { api } from "../lib/api.ts";
import { useToast } from "../lib/toast.tsx";
import { saveFile, today } from "../lib/share.ts";
import type { Warlord } from "../../core/types.ts";
import { MEISHO_ROSTER, ROSTER_NAMES, matchMeishoRoster } from "../../core/meisho.ts";
import { meishoTalentGaps } from "../../core/missing.ts";
import { SIM_MEISHO, simMeishoTalents } from "../../core/meishoSimData.ts";
import { StoredImage } from "./StoredImage.tsx";

// 「データ管理」の名将一覧: ゲーム内の「名将一覧」の武将が図鑑のどの武将か、登録されていない名将はいないかを見せる

export function MeishoPanel({
  warlords,
  onOpenWarlord,
  onChanged,
}: {
  warlords: Warlord[];
  onOpenWarlord: (id: string) => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [progress, setProgress] = useState<string | null>(null);
  // 名将一覧を開いた時は、最新の図鑑の内容を読み直す (解析キューでの選び直しなどを反映する)
  useEffect(() => {
    onChanged();
    // 開いた時に 1 回だけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // どの名将にも入っていない名将修行の画面の枚数 (見分けに失敗したままの分)
  const [unassigned, setUnassigned] = useState(0);
  useEffect(() => {
    void api.unassignedTrainingImages().then((ids) => setUnassigned(ids.length)).catch(() => setUnassigned(0));
  }, [warlords]);
  const matches = useMemo(() => matchMeishoRoster(warlords), [warlords]);
  const ambiguous = matches
    .filter((m) => m.candidates.length > 0 && m.decided.length === 0 && !m.candidates.some((w) => w.meisho_manual))
    .flatMap((m) => m.candidates);
  const meishoCount = warlords.filter((w) => w.is_meisho).length;
  // 名将修行の追加天賦 (丸 8 つ) がそろっているか
  const gaps = warlords
    .filter((w) => w.is_meisho)
    .map((w) => ({ w, gaps: meishoTalentGaps(w) }))
    .filter((g) => g.gaps.length > 0)
    .sort((a, b) => a.w.faction.localeCompare(b.w.faction, "ja") || a.w.name.localeCompare(b.w.name, "ja"));

  const checkWithAi = async () => {
    if (!confirm(`同じ名前の武将がいて名将か決められない ${ambiguous.length} 人を、AI に登録画像を見せて見分けますか？\nAI に最大 ${ambiguous.length} 回問い合わせます。この iPhone で調べるので、終わるまでアプリを開いたままにしてください。`)) return;
    try {
      const r = await api.checkAmbiguousMeisho((done, total, name) => setProgress(`${done} / ${total}${name ? ` ${name}` : ""}`));
      const notes = [
        r.notMeisho && `名将ではない ${r.notMeisho} 人`,
        r.unknown.length && `スキル画面のスクショが無く分からない ${r.unknown.length} 人 (${r.unknown.join("、")})`,
        r.stopped && `途中で止まりました: ${r.stopped}`,
      ].filter(Boolean);
      toast(r.stopped ? "warning" : "success", `${r.marked} 人を名将と見分けました`, notes.join(" / ") || undefined);
      onChanged();
    } catch (e) {
      toast("error", "見分けられませんでした", (e as Error).message);
    } finally {
      setProgress(null);
    }
  };

  const toggle = async (w: Warlord) => {
    try {
      await api.setMeisho(w.id, !w.is_meisho);
      onChanged();
    } catch (e) {
      toast("error", "変更できませんでした", (e as Error).message);
    }
  };

  const save = async (format: "txt" | "json" | "training") => {
    try {
      const r = await api.exportMeisho(format);
      if (r.count === 0) return toast("info", "名将の印が付いた武将がいません");
      await saveFile(r.blob, format === "training" ? `名将修行-${today()}.txt` : `名将-${today()}.${format}`, "戦国布武 名将の武将");
    } catch (e) {
      toast("error", "保存できませんでした", (e as Error).message);
    }
  };
  // 名将の方が選ばれていて、名将修行もそろっている (シミュレーターのデータがある・8 つ入っている) 名将は、ふだんは出さない
  const [showAll, setShowAll] = useState(false);
  const done = (m: (typeof matches)[number]) =>
    m.candidates.some((w) => w.is_meisho && (simMeishoTalents(w) !== null || meishoTalentGaps(w).length === 0));
  const shown = showAll ? matches : matches.filter((m) => !done(m));
  const factions = [...new Set(shown.map((m) => m.faction))];
  const missing = matches.filter((m) => m.candidates.length === 0).length;
  const choose = matches.filter((m) => m.candidates.length > 0 && m.decided.length === 0 && !m.candidates.some((w) => w.meisho_manual)).length;
  return (
    <section className="panel p-5 md:col-span-2">
      <h2 className="mb-1 flex items-center gap-2 font-serif text-lg font-bold text-gold-400">
        <Crown className="size-5" /> 名将一覧
      </h2>
      <p className="mb-3 text-sm text-ash">
        ゲーム内の「名将一覧」に並ぶ武将です。勢力と名前が合う武将には、自動で「名将」の印を付けています。
        {" 立ち絵の横のボタンで、手で名将を付け外しできます (手で決めた武将は、自動の判断で変わりません)。"}
        {choose > 0 && ` 同じ勢力に同じ名前の武将が何人もいる ${choose} 件は、立ち絵を見て名将の方を選ぶか、AI で見分けてください。`}
        {missing > 0 && ` まだ図鑑に登録されていない名将が ${missing} 人います。`}
      </p>
      <div className="mb-4 flex flex-wrap gap-2">
        {ambiguous.length > 0 && (
          <button
            onClick={() => void checkWithAi()}
            disabled={progress !== null}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gold-600/60 px-3 py-1.5 text-sm text-gold-300 disabled:opacity-50"
          >
            <Sparkles className="size-4" /> {progress ? `見分けています… ${progress}` : `同じ名前の ${ambiguous.length} 人を AI で見分ける`}
          </button>
        )}
        <button onClick={() => void save("txt")} className="inline-flex items-center gap-1.5 rounded-lg border border-ebony-600 px-3 py-1.5 text-sm text-washi">
          <Download className="size-4" /> 名将だけ保存 (.txt・{meishoCount} 人)
        </button>
        {unassigned > 0 && (
          <button
            onClick={() =>
              void api.reidentifyUnassignedTraining().then((n) => {
                toast("info", `どの名将にも入っていない名将修行の画面 ${n} 枚を見分け直します`, "読み取りはやり直しません。進み具合は「スクショ解析」タブで見られます");
                onChanged();
              })
            }
            className="inline-flex items-center gap-1.5 rounded-lg border border-hi-500 bg-hi-800/30 px-3 py-1.5 text-sm font-bold text-hi-300"
          >
            <Sparkles className="size-4" /> どの名将にも入っていない名将修行の画面を見分け直す ({unassigned} 枚)
          </button>
        )}
        <button
          onClick={() =>
            void (async () => {
              if (
                !confirm(
                  "今までに送った名将修行の画面を、保存してある画像からすべて解析し直しますか？\nスクショを送り直す必要はありません。誰の画面かを決め直して、丸 8 つに入れ直します (文字の読み取りはやり直しません)。\n手で振り分けた名将の画面はそのまま残します。サーバーで進むので、アプリを閉じていても大丈夫です。",
                )
              )
                return;
              const n = await api.reidentifyMeishoTraining();
              if (n === 0) toast("info", "保存してある名将修行の画面がありません", "名将修行のスクショを取り込み直してください");
              else toast("info", `${n} 枚の名将修行の画面を見分け直します`, "進み具合は「スクショ解析」タブで見られます");
              onChanged();
            })()
          }
          className="inline-flex items-center gap-1.5 rounded-lg border border-hi-600/60 px-3 py-1.5 text-sm text-hi-400"
        >
          <Sparkles className="size-4" /> 送った名将修行の画面をすべて解析し直す (送り直し不要)
        </button>
        <button onClick={() => void save("training")} className="inline-flex items-center gap-1.5 rounded-lg border border-shu-500/60 px-3 py-1.5 text-sm text-washi">
          <Download className="size-4" /> 名将修行の追加天賦だけ保存 (.txt)
        </button>
        <button onClick={() => void save("json")} className="inline-flex items-center gap-1.5 rounded-lg border border-ebony-600 px-3 py-1.5 text-sm text-washi">
          <Download className="size-4" /> 名将だけ保存 (.json)
        </button>
      </div>
      {(() => {
        // シミュレーターに名将修行のデータが無い名将 (図鑑で読み取る分) について、誰の何が足りないか
        const rows = matches
          .filter((m) => !SIM_MEISHO.some((x) => x.faction === m.faction && x.name === m.name))
          .flatMap((m) => {
            if (m.candidates.length === 0) return [{ key: `${m.faction}|${m.name}`, label: `${m.name} (${m.faction})`, w: null as Warlord | null, gaps: ["図鑑に未登録"] }];
            // 同じ名前が何人もいる時は、名将の印がある武将 (無ければ全員) を見る
            const ws = m.candidates.some((w) => w.is_meisho) ? m.candidates.filter((w) => w.is_meisho) : m.candidates;
            return ws.map((w) => ({
              key: w.id,
              label: `${w.is_special ? "【特】" : ""}${w.name} (${m.faction})`,
              w: w as Warlord | null,
              gaps: w.is_meisho ? meishoTalentGaps(w) : ["名将の印が無い", ...meishoTalentGaps({ ...w, is_meisho: true })],
            }));
          });
        const todo = rows.filter((r) => r.gaps.length > 0);
        return (
          <div className={`mb-4 rounded-lg border p-3 text-xs ${todo.length ? "border-hi-600/60" : "border-emerald-700/60"}`}>
            <p className={`font-bold ${todo.length ? "text-hi-400" : "text-emerald-300"}`}>
              図鑑で読み取る名将 (シミュレーターに無い {rows.length} 人): 8 つそろっている {rows.length - todo.length} 人 / 足りない {todo.length} 人
            </p>
            <p className="mt-0.5 text-ash">シミュレーターに直接渡した 46 人は、書き出すファイルにそのデータが入るので、ここには出しません。</p>
            {todo.length > 0 && (
              <ul className="mt-1.5 space-y-1">
                {todo.map((r) => (
                  <li key={r.key}>
                    {r.w ? (
                      <button onClick={() => onOpenWarlord(r.w!.id)} className="text-left text-washi underline-offset-2 hover:underline">
                        {r.label}
                      </button>
                    ) : (
                      <span className="text-washi">{r.label}</span>
                    )}
                    <span className="ml-1 text-ash">
                      {(() => {
                        const notes = r.gaps.filter((g) => !/少史|大史|少納言|大輔|中納言/.test(g));
                        const slots = r.gaps.filter((g) => /少史|大史|少納言|大輔|中納言/.test(g));
                        const slotText = !r.w || slots.length >= 8 ? "8 つとも未取得" : slots.length ? `足りない: ${slots.join("、")}` : "";
                        return [...notes, slotText].filter(Boolean).join(" / ");
                      })()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })()}
      <TrainingSorter warlords={warlords} onChanged={onChanged} />
      <div className="space-y-3">
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ash">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="accent-gold-500" />
          そろっている名将も表示する (ふだんは、名将の方が決まっていない・名将修行が足りない名将だけ)
        </label>
        {factions.length === 0 && <p className="text-xs text-emerald-300">すべての名将がそろっています</p>}
        {factions.map((f) => (
          <div key={f}>
            <p className="mb-1 text-xs font-bold text-gold-300">{f}</p>
            <ul className="flex flex-wrap gap-1.5">
              {shown
                .filter((m) => m.faction === f)
                .map((m) => {
                  const label = `${m.name}${m.count > 1 ? ` ×${m.count}` : ""}`;
                  if (m.candidates.length === 0) {
                    return (
                      <li key={m.name + (m.group ?? "")} className="rounded border border-dashed border-ebony-600 px-2 py-0.5 text-xs text-ebony-500" title="図鑑に未登録">
                        {label} (未登録)
                      </li>
                    );
                  }
                  const unsure = m.decided.length === 0 && !m.candidates.some((w) => w.meisho_manual);
                  return (
                    <li
                      key={m.name + (m.group ?? "")}
                      className={`rounded-lg border p-1.5 text-xs ${unsure ? "border-hi-600/60" : "border-ebony-700"}`}
                      title={m.group}
                    >
                      {unsure && <p className="mb-1 text-hi-400">{label}: 名将の方を選んでください</p>}
                      <div className="flex flex-wrap gap-1.5">
                        {m.candidates.map((w) => (
                          <MeishoChoice key={w.id} w={w} onOpen={() => onOpenWarlord(w.id)} onToggle={() => void toggle(w)} />
                        ))}
                      </div>
                    </li>
                  );
                })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

/** 名将の候補 1 人: 立ち絵 (押すと武将を開く) と、名将の付け外しボタン */
function MeishoChoice({ w, onOpen, onToggle }: { w: Warlord; onOpen: () => void; onToggle: () => void }) {
  return (
    <div className={`flex items-center gap-1.5 rounded border px-1 py-1 ${w.is_meisho ? "border-shu-500/70 bg-shu-700/20" : "border-ebony-700"}`}>
      <button onClick={onOpen} className="flex items-center gap-1.5 text-left" aria-label={`${w.name} を開く`}>
        {w.image_url ? (
          <StoredImage id={w.image_url} alt="" className="h-12 w-9 shrink-0 rounded object-cover object-left" />
        ) : (
          <span className="grid h-12 w-9 place-items-center rounded bg-ebony-800 font-serif text-ebony-500">{w.name.slice(0, 1)}</span>
        )}
        <span className="max-w-24 truncate text-washi">
          {w.is_special ? "【特】" : ""}
          {w.name}
          <span className="ml-1 text-[10px] text-ash">修行 {w.meisho_talents?.length ?? 0}/8</span>
          {w.title_alias && <span className="block truncate text-[10px] text-ash">{w.title_alias}</span>}
        </span>
      </button>
      <button
        onClick={onToggle}
        className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${w.is_meisho ? "bg-shu-600 text-white" : "border border-ebony-600 text-ash"}`}
      >
        {w.is_meisho ? "名将 ✓" : "名将にする"}
      </button>
    </div>
  );
}

/**
 * 名将修行の画面を、カードの絵が同じものどうし (= 同じ名将) の組に分けて見せ、組ごとに手で名将を選んでもらう (AI なし)。
 * AI の見分けが当てにならない時用
 */
function TrainingSorter({ warlords, onChanged }: { warlords: Warlord[]; onChanged: () => void }) {
  const toast = useToast();
  const [groups, setGroups] = useState<Awaited<ReturnType<typeof api.trainingGroups>> | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    try {
      setGroups(await api.trainingGroups());
    } finally {
      setLoading(false);
    }
  };
  // 選べる名将: シミュレーターにデータが無い名将 (名将一覧に勢力ごと載っている武将を先に)
  const choices = useMemo(() => {
    const special = ["限定武将", "コラボ武将", "姫武将"];
    return warlords
      .map((w) => ({ w, exact: MEISHO_ROSTER.some((e) => e.faction === w.faction && e.name === w.name) }))
      .filter(({ w, exact }) => exact || w.is_meisho || (ROSTER_NAMES.has(w.name) && special.includes(w.faction)))
      .sort((a, b) => Number(b.exact) - Number(a.exact) || a.w.faction.localeCompare(b.w.faction, "ja") || a.w.name.localeCompare(b.w.name, "ja"));
  }, [warlords]);
  return (
    <details className="mb-4 rounded-lg border border-ebony-700 p-3 text-xs" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && !groups && void load()}>
      <summary className="cursor-pointer text-sm font-bold text-gold-300">名将修行の画面を手で振り分ける (AI の見分けが違う時)</summary>
      <p className="mt-1 text-ash">
        カードの絵が同じ画面を 1 組にまとめています (同じ名将の画面)。組ごとに、どの名将の画面か選んでください。前に別の武将に入っていた分はそこから外して入れ直します。AI は使いません。
      </p>
      {loading && <p className="mt-2 text-ash">まとめています…</p>}
      {groups?.length === 0 && <p className="mt-2 text-ash">保存してある名将修行の画面がありません</p>}
      <ul className="mt-2 space-y-2">
        {groups?.map((g) => (
          <li key={g.images[0]} className="flex gap-2 rounded border border-ebony-700 p-2">
            {/* 画面の左のカードの絵だけを見せる */}
            <div className="relative h-20 w-16 shrink-0 overflow-hidden rounded bg-ebony-800">
              <StoredImage id={g.images[0]} alt="" style={{ position: "absolute", width: "500%", maxWidth: "none", left: "-85%", top: "-28%" }} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-washi">
                {g.images.length} 枚 ・ いま: {g.owners.length ? g.owners.map((w) => `${w.name} (${w.faction || "勢力未入力"})`).join("、") : "どの名将にも入っていない"}
              </p>
              {/* 1 人の名将に、カードの絵が違う組が 2 つ以上入っている = どちらかが取り違え */}
              {g.owners.some((w) => (groups ?? []).filter((x) => x.owners.some((o) => o.id === w.id)).length > 1) && (
                <p className="font-bold text-hi-400">※ この名将には、絵の違う別の組も入っています。どちらかが取り違えです。正しい名将を選び直してください</p>
              )}
              <p className="truncate text-[11px] text-ash">{g.talents.map((t) => `${t.rank}${t.slot ? ` ${t.slot}` : ""}:${t.effect}`).join(" / ")}</p>
              <select
                className="field mt-1 text-xs"
                value=""
                onChange={(e) => {
                  const id = e.target.value;
                  const w = warlords.find((x) => x.id === id);
                  if (!w) return;
                  void api
                    .assignTrainingGroup(g.images, id)
                    .then(async () => {
                      toast("success", `${g.images.length} 枚を「${w.name}」(${w.faction}) の名将修行に入れました`);
                      onChanged();
                      await load();
                    })
                    .catch((err: Error) => toast("error", "入れられませんでした", err.message));
                }}
              >
                <option value="">どの名将の画面か選ぶ</option>
                {choices.map(({ w, exact }) => (
                  <option key={w.id} value={w.id}>
                    {w.is_special ? "【特】" : ""}
                    {w.name} ({w.faction || "勢力未入力"}){exact ? "" : " ※名将一覧の勢力と違う"} ・修行 {w.meisho_talents?.length ?? 0}/8
                  </option>
                ))}
              </select>
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}
