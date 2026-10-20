import { Swords } from "lucide-react";

export function SpecialBadge({ size = "sm" }: { size?: "sm" | "md" }) {
  return (
    <span
      title="特異武将"
      className={`inline-grid shrink-0 place-items-center rounded border border-gold-300/70 bg-gradient-to-b from-gold-400 to-gold-600 font-serif font-extrabold text-ebony-950 shadow-[0_0_10px_rgb(226_192_108/0.45)] ${
        size === "md" ? "size-7 text-base" : "size-5 text-xs"
      }`}
    >
      特
    </span>
  );
}

export function WeaponBadge() {
  return (
    <span
      title="専用武器覚醒あり"
      className="inline-flex shrink-0 items-center gap-0.5 rounded border border-hi-500/70 bg-hi-800/80 px-1.5 py-0.5 text-[10px] font-bold text-hi-400"
    >
      <Swords className="size-3" />
      武器覚醒
    </span>
  );
}

const RARITY_STYLE: Record<string, string> = {
  SSR: "from-shu-300 via-shu-500 to-shu-600 text-ebony-950",
  SP: "from-hi-400 to-hi-600 text-white",
  SR: "from-violet-300 to-violet-600 text-white",
  R: "from-sky-300 to-sky-600 text-white",
  N: "from-stone-300 to-stone-500 text-ebony-950",
};

export function RarityBadge({ rarity, size = "sm" }: { rarity: string; size?: "sm" | "md" }) {
  if (!rarity) return null;
  const sizing = size === "md" ? "rounded-full px-4 py-1 text-base" : "rounded px-1.5 py-0.5 text-[10px]";
  return (
    <span className={`bg-gradient-to-b font-extrabold tracking-wider ${sizing} ${RARITY_STYLE[rarity] ?? RARITY_STYLE.N}`}>
      {rarity}
    </span>
  );
}

export function Stars({ count, className = "" }: { count: number; className?: string }) {
  return (
    <span className={`tracking-tight ${className}`} aria-label={`星${count}`}>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className={i < count ? "text-gold-400" : "text-ebony-600"}>
          ★
        </span>
      ))}
    </span>
  );
}
