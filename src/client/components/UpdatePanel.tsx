import { useEffect, useState } from "react";
import { Download, Sparkles } from "lucide-react";
import { api } from "../lib/api.ts";
import { useToast } from "../lib/toast.tsx";
import { saveFile, today } from "../lib/share.ts";
import type { Warlord } from "../../core/types.ts";
import type { UpdateBaseline, UpdateDiff } from "../../core/update.ts";

// 「データ管理」のゲームのアップデート: 始めた時の図鑑と比べて、アップデートで変わった所だけをファイルにする

type Report = { base: UpdateBaseline; diff: UpdateDiff; renameHints: { added: Warlord; existing: Warlord }[] };

const defaultLabel = () => {
  const d = new Date();
  return `${d.getFullYear()}年${d.getMonth() + 1}月アップデート`;
};

const nameOf = (w: { name: string; is_special: boolean; faction: string }) => `${w.is_special ? "【特】" : ""}${w.name} (${w.faction || "勢力未入力"})`;

export function UpdatePanel({ warlords, onChanged, onOpenWarlord }: { warlords: Warlord[]; onChanged: () => void; onOpenWarlord: (id: string) => void }) {
  const toast = useToast();
  const [base, setBase] = useState<UpdateBaseline | null>(() => api.updateBaseline());
  const [label, setLabel] = useState(defaultLabel);
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [zips, setZips] = useState<{ blob: Blob; name: string }[]>([]);
  // 始め忘れた時の、取り込みを始めた日 (この日の 0 時から)
  const [sinceDay, setSinceDay] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });

  // 図鑑が変わるたびに、変わった所を数え直す
  useEffect(() => {
    if (!base) return setReport(null);
    let alive = true;
    void api.updateReport().then((r) => alive && setReport(r));
    return () => {
      alive = false;
    };
  }, [base, warlords]);

  const save = (z: { blob: Blob; name: string }) => saveFile(z.blob, z.name, "戦国布武 アップデートの変更点");

  const start = async () => {
    if (!label.trim()) return toast("info", "アップデートの名前を入れてください");
    setBase(await api.startUpdate(label.trim()));
    setZips([]);
    toast("success", "アップデートの取り込みを始めました", "このあと取り込んだスクショの分が「アップデートの変更点」になります");
  };

  const startSince = async () => {
    if (!label.trim()) return toast("info", "アップデートの名前を入れてください");
    const since = new Date(`${sinceDay}T00:00:00`);
    if (Number.isNaN(since.getTime())) return toast("info", "日付を選んでください");
    const after = warlords.filter((w) => Date.parse(w.created_at) >= since.getTime()).length;
    if (!confirm(`${sinceDay} の 0 時から取り込みを始めたことにしますか？\nこの日より後に登録された武将 ${after} 人が「新しい武将」になります。`)) return;
    setBase(await api.startUpdateSince(label.trim(), since));
    setZips([]);
    toast("success", `${sinceDay} から始めたことにしました`, "名前の変更・武器覚醒の追加・シーズンの変更は、前の状態が分からないので比べません");
  };

  const exportZip = async () => {
    setBusy(true);
    try {
      const r = await api.exportUpdateZip();
      if (!r) return;
      const n = r.blobs.length;
      const stem = `アップデート-${today()}`;
      const list = r.blobs.map((blob, i) => ({ blob, name: n === 1 ? `${stem}.zip` : `${stem}-${i + 1}of${n}.zip` }));
      setZips(list);
      toast("success", `変更点をまとめました (変わった武将 ${r.changed} 人)`, "変更点のテキスト・JSON と、新しい武将などの立ち絵が入っています");
      if (n === 1) await save(list[0]);
    } catch (e) {
      toast("error", "変更点をまとめられませんでした", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const end = () => {
    if (!confirm("アップデートの取り込みを終えますか？\n変更点のファイルを保存してから終えてください (終えると、何が変わったかの比べる元が消えます。図鑑のデータは消えません)")) return;
    api.endUpdate();
    setBase(null);
    setZips([]);
  };

  const rename = async (existing: Warlord, added: Warlord) => {
    if (!confirm(`「${nameOf(existing)}」の名前が「${added.name}」に変わったとして、2 人を 1 人にまとめますか？\n前からいた武将の名将修行・手で直した内容は残り、名前が「${added.name}」になります。`)) return;
    try {
      await api.applyRename(existing.id, added.id);
      toast("success", `「${existing.name}」を「${added.name}」にまとめました`);
      onChanged();
    } catch (e) {
      toast("error", "まとめられませんでした", (e as Error).message);
    }
  };

  const d = report?.diff;
  return (
    <section className="panel p-5 md:col-span-2">
      <h2 className="mb-1 flex items-center gap-2 font-serif text-lg font-bold text-gold-400">
        <Sparkles className="size-5" /> ゲームのアップデートの取り込み
      </h2>
      {!base ? (
        <>
          <p className="mb-3 text-sm text-ash">
            ゲームのアップデート (新しい武将・鬼のシーズン・名将になった武将・武器覚醒の追加・名前の変更) の分だけをファイルにします。
            <br />① ここで「始める」を押す → ② アップデートで増えた・変わった武将のスクショを、いつも通り取り込む → ③ ここで「変更点を書き出す」
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input className="field max-w-xs" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="例: 2026年12月アップデート" />
            <button
              onClick={() => void start()}
              className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-b from-gold-500 to-gold-600 px-4 py-2 font-bold text-ebony-950"
            >
              <Sparkles className="size-4" /> 取り込みを始める
            </button>
          </div>
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-gold-300">「始める」を押し忘れて、もう取り込んでしまった時</summary>
            <p className="mt-2 text-xs text-ash">
              アップデートのスクショを取り込み始めた日を選ぶと、その日より後に登録された武将を「新しい武将」にします。名将は、ゲームの名将一覧に無いのに名将の印がある武将を「名将になった武将」にします。
              名前の変更・武器覚醒の追加・鬼のシーズンの変更は、前の状態が残っていないので比べません (名前の変更は、立ち絵が同じ武将の候補として出ます)。
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input type="date" className="field max-w-[11rem]" value={sinceDay} onChange={(e) => setSinceDay(e.target.value)} />
              <button onClick={() => void startSince()} className="rounded-lg border border-gold-600/60 px-3 py-2 text-sm font-bold text-gold-300">
                この日から始めたことにする
              </button>
            </div>
          </details>
        </>
      ) : (
        <>
          <p className="mb-3 text-sm text-ash">
            「{base.label}」を取り込み中 ({base.started_at.slice(0, 10)} から)。この後に取り込んだ分が変更点になります。終わったら「変更点を書き出す」を押してください。
          </p>
          {d && (
            <ul className="mb-3 grid gap-1 text-sm sm:grid-cols-2">
              <li>新しい武将: {d.added.length} 人</li>
              <li>名将になった武将: {d.newMeisho.length} 人</li>
              <li>武器覚醒の追加: {d.newWeaponAwakening.length} 人</li>
              <li>名前の変更: {d.renamed.length} 人</li>
              <li>鬼のシーズンの変更: {d.seasonChanged.length} 人</li>
              <li className="sm:col-span-2">新しい鬼のシーズン: {d.newSeasons.length ? d.newSeasons.join("、") : "なし"}</li>
            </ul>
          )}
          {d && d.added.length > 0 && (
            <details className="mb-3 text-sm">
              <summary className="cursor-pointer text-gold-300">新しい武将 ({d.added.length} 人) を見る</summary>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {d.added.map((w) => (
                  <button key={w.id} onClick={() => onOpenWarlord(w.id)} className="rounded-md border border-ebony-700 px-2 py-0.5 text-xs">
                    {nameOf(w)}
                  </button>
                ))}
              </div>
            </details>
          )}
          {report && report.renameHints.length > 0 && (
            <div className="mb-3 rounded-lg border border-amber-500/50 bg-amber-900/20 p-3 text-sm">
              <p className="font-bold text-amber-200">名前が変わったかもしれない武将</p>
              <p className="mb-2 text-xs text-amber-100/80">新しい名前で別の武将として登録されましたが、前からいた武将と立ち絵がほぼ同じです。同じ武将なら「まとめる」を押してください。</p>
              <ul className="space-y-1.5">
                {report.renameHints.map((h) => (
                  <li key={h.added.id} className="flex flex-wrap items-center gap-2">
                    <span>
                      {nameOf(h.existing)} → {h.added.name}
                    </span>
                    <button onClick={() => void rename(h.existing, h.added)} className="rounded-md border border-amber-400/60 px-2 py-0.5 text-xs font-bold text-amber-200">
                      まとめる
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => void exportZip()}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-b from-gold-500 to-gold-600 px-4 py-2 font-bold text-ebony-950 disabled:opacity-50"
            >
              <Download className="size-4" /> {busy ? "まとめています…" : "変更点を書き出す (.zip)"}
            </button>
            <button onClick={end} className="rounded-lg border border-ebony-600 px-4 py-2 text-sm text-ash">
              取り込みを終える
            </button>
          </div>
          {zips.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {zips.map((z, i) => (
                <button key={z.name} onClick={() => void save(z)} className="inline-flex items-center gap-1.5 rounded-lg border border-gold-600/60 px-3 py-1.5 text-sm text-gold-300">
                  <Download className="size-4" /> {zips.length > 1 ? `${i + 1} / ${zips.length} を保存` : "もう一度保存"} ({(z.blob.size / 1_000_000).toFixed(1)}MB)
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
