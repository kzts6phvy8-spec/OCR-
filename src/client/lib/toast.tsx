import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";

type ToastKind = "success" | "error" | "warning" | "info";
interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
}

const ToastContext = createContext<(kind: ToastKind, title: string, detail?: string) => void>(() => {});

export const useToast = () => useContext(ToastContext);

const STYLE: Record<ToastKind, { icon: typeof Info; cls: string }> = {
  success: { icon: CheckCircle2, cls: "border-gold-600/60 text-gold-300" },
  error: { icon: XCircle, cls: "border-hi-500/70 text-hi-400" },
  warning: { icon: AlertTriangle, cls: "border-amber-500/60 text-amber-300" },
  info: { icon: Info, cls: "border-ebony-500 text-washi" },
};

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));
  const push = useCallback((kind: ToastKind, title: string, detail?: string) => {
    const id = nextId++;
    setToasts((t) => [...t.slice(-4), { id, kind, title, detail }]);
    setTimeout(() => dismiss(id), kind === "error" ? 9000 : 5000);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 left-4 z-[100] flex flex-col items-end gap-2 sm:left-auto">
        {toasts.map((t) => {
          const { icon: Icon, cls } = STYLE[t.kind];
          return (
            <div
              key={t.id}
              role="status"
              className={`toast-in pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border bg-ebony-900/95 px-4 py-3 shadow-2xl backdrop-blur ${cls}`}
            >
              <Icon className="mt-0.5 size-5 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold">{t.title}</p>
                {t.detail && <p className="mt-0.5 text-xs break-words text-ash">{t.detail}</p>}
              </div>
              <button onClick={() => dismiss(t.id)} className="text-ash hover:text-washi" aria-label="閉じる">
                <X className="size-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
