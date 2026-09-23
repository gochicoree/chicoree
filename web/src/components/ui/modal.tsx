"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "./button";
import { Input } from "./field";

/**
 * Accessible modal dialog: backdrop, Escape to close, focus moved inside on
 * open and restored on close. Renders nothing while closed. On phones it
 * docks to the bottom as a sheet and scrolls its body; on larger screens it
 * floats centered.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** Panel width on larger screens; phones always use the full width. */
  size?: "md" | "lg" | "xl";
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const first =
      panelRef.current?.querySelector<HTMLElement>("[data-autofocus]") ??
      panelRef.current?.querySelector<HTMLElement>(
        "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
      );
    (first ?? panelRef.current)?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && panelRef.current) {
        // Keep focus inside the dialog.
        const focusables = Array.from(
          panelRef.current.querySelectorAll<HTMLElement>(
            "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
          ),
        ).filter((el) => !el.hasAttribute("disabled"));
        if (focusables.length === 0) return;
        const firstEl = focusables[0];
        const lastEl = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === firstEl) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      restoreRef.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4" role="presentation">
      <div className="absolute inset-0 animate-fade-in bg-overlay backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
        className={`relative flex max-h-[calc(100dvh-1.5rem)] w-full flex-col rounded-t-2xl border border-line bg-card shadow-card outline-none sm:max-h-[calc(100dvh-2rem)] sm:rounded-xl ${
          size === "xl" ? "sm:max-w-4xl" : size === "lg" ? "sm:max-w-2xl" : "sm:max-w-md"
        }`}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-4 sm:px-5">
          <div className="min-w-0">
            <h2 id="modal-title" className="font-display text-base font-semibold">
              {title}
            </h2>
            {description && <div className="mt-1 text-sm text-ink-2">{description}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1.5 -mt-1.5 flex size-9 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-card-2 hover:text-ink cursor-pointer"
          >
            <X className="size-4" />
          </button>
        </div>
        {children && (
          <div
            className={`min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5 ${
              footer ? "" : "pb-[max(1rem,env(safe-area-inset-bottom))]"
            }`}
          >
            {children}
          </div>
        )}
        {footer && (
          <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Confirm/cancel dialog with a danger or primary confirm button. With
 * `confirmText` the confirm button stays disabled until the user types that
 * text (the name of what is about to be destroyed) into a field below the
 * body; the field is cleared whenever the dialog closes.
 */
export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Confirm",
  tone = "primary",
  busy,
  confirmText,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  tone?: "primary" | "danger" | "accent";
  busy?: boolean;
  /** Exact text the user has to type before the confirm button works. */
  confirmText?: string;
  children?: ReactNode;
}) {
  const [typed, setTyped] = useState("");
  const inputId = useId();
  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);
  const armed = !confirmText || typed.trim() === confirmText;

  function submit() {
    if (armed && !busy) onConfirm();
  }

  const field = confirmText ? (
    <div className={children ? "mt-4" : undefined}>
      <label htmlFor={inputId} className="mb-1.5 block text-[13px] font-medium text-ink">
        Type <code className="rounded bg-card-2 px-1 py-0.5 font-mono text-[13px] select-all">{confirmText}</code> to confirm
      </label>
      <Input
        id={inputId}
        data-autofocus
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className="font-mono"
        aria-invalid={typed !== "" && !armed ? true : undefined}
      />
    </div>
  ) : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant={tone} onClick={submit} disabled={busy || !armed}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {field ? (
        <>
          {children}
          {field}
        </>
      ) : (
        children
      )}
    </Modal>
  );
}
