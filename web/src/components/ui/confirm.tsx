"use client";

import { useCallback, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ConfirmModal } from "./modal";

interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  tone?: "primary" | "danger" | "accent";
  /** Text that has to be typed before the confirm button enables. */
  confirmText?: string;
}

/**
 * A form whose submission first opens a confirmation dialog. Put the hidden
 * fields and the submit button inside as usual; the server action only runs
 * once the person confirmed. With `confirmText` the dialog asks them to type
 * it, and `confirmInputName` submits what they typed with the form so the
 * action can check it again.
 */
export function ConfirmForm({
  action,
  className,
  children,
  confirmInputName,
  ...dialog
}: ConfirmOptions & {
  action: (formData: FormData) => void | Promise<void>;
  className?: string;
  confirmInputName?: string;
  children: ReactNode;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const armed = useRef(false);
  const [open, setOpen] = useState(false);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    if (armed.current) {
      armed.current = false;
      return;
    }
    e.preventDefault();
    setOpen(true);
  }

  return (
    <form ref={formRef} action={action} onSubmit={onSubmit} className={className}>
      {children}
      <ConfirmModal
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={() => {
          // Submit while the dialog's typed field is still in the DOM, so it
          // travels with the form data; then close.
          armed.current = true;
          formRef.current?.requestSubmit();
          setOpen(false);
        }}
        confirmInputName={confirmInputName}
        {...dialog}
      />
    </form>
  );
}

/**
 * Confirmation for click handlers: `confirm(options, run)` opens the dialog
 * and calls `run` once confirmed (the dialog stays up, disabled, while an
 * async `run` is in flight). Render `dialog` somewhere in the component.
 */
export function useConfirm() {
  const [pending, setPending] = useState<{ options: ConfirmOptions; run: () => void | Promise<void> } | null>(null);
  const [busy, setBusy] = useState(false);

  const confirm = useCallback((options: ConfirmOptions, run: () => void | Promise<void>) => {
    setPending({ options, run });
  }, []);

  const close = () => {
    if (!busy) setPending(null);
  };

  const dialog = pending ? (
    <ConfirmModal
      open
      onClose={close}
      busy={busy}
      onConfirm={async () => {
        setBusy(true);
        try {
          await pending.run();
        } finally {
          setBusy(false);
          setPending(null);
        }
      }}
      {...pending.options}
    />
  ) : null;

  return { confirm, dialog };
}
