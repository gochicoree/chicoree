"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { clsx } from "clsx";

export type ToastTone = "success" | "error" | "info";

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Milliseconds before auto-dismiss; 0 keeps it until closed. */
  duration?: number;
}

interface ToastItem {
  id: number;
  title: string;
  description?: string;
  tone: ToastTone;
}

interface ToastApi {
  toast: (options: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * App-wide transient notifications ("Saved", "Invitation sent"). Mounted once
 * in the root layout; components call useToast().
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setItems((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (options: ToastOptions) => {
      const id = ++seq.current;
      const item: ToastItem = {
        id,
        title: options.title,
        description: options.description,
        tone: options.tone ?? "success",
      };
      // Keep the stack short: the newest four.
      setItems((list) => [...list.slice(-3), item]);
      const duration = options.duration ?? 4000;
      if (duration > 0) timers.current.set(id, setTimeout(() => dismiss(id), duration));
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((t) => clearTimeout(t));
  }, []);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[60] flex flex-col items-center gap-2 sm:inset-x-auto sm:bottom-4 sm:right-4 sm:items-end"
      >
        {items.map((item) => (
          <ToastCard key={item.id} item={item} onClose={() => dismiss(item.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const ICONS: Record<ToastTone, { Icon: typeof CheckCircle2; className: string }> = {
  success: { Icon: CheckCircle2, className: "text-ok" },
  error: { Icon: AlertTriangle, className: "text-danger" },
  info: { Icon: Info, className: "text-action" },
};

function ToastCard({ item, onClose }: { item: ToastItem; onClose: () => void }) {
  const { Icon, className } = ICONS[item.tone];
  return (
    <div
      role="status"
      className="pointer-events-auto flex w-full max-w-sm animate-toast-in items-start gap-3 rounded-xl border border-line bg-card py-3 pl-3.5 pr-2 shadow-card"
    >
      <Icon className={clsx("mt-0.5 size-4 shrink-0", className)} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-ink">{item.title}</div>
        {item.description && <div className="mt-0.5 text-xs text-ink-2">{item.description}</div>}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Dismiss"
        className="-my-1 flex size-7 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-card-2 hover:text-ink cursor-pointer"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

type ActionState = { error?: string | null; saved?: boolean } | null | undefined;

/**
 * Toast once per completed server action (useActionState): fires when the
 * state object changes and `ok` holds. Default: no error, and `saved` is
 * true or absent (results that carry other data, like previews, pass `ok`).
 */
export function useActionToast<S extends ActionState>(
  state: S,
  title: string,
  ok: (state: NonNullable<S>) => boolean = (s) => !s.error && s.saved !== false,
) {
  const { toast } = useToast();
  const last = useRef<S>(state);
  useEffect(() => {
    if (state === last.current) return;
    last.current = state;
    if (state && ok(state as NonNullable<S>)) toast({ title, tone: "success" });
  }, [state, title, ok, toast]);
}
