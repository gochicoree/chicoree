"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { ConfirmModal } from "./modal";

interface Dialog {
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  /** Button label while the action runs; defaults to `confirmLabel`. */
  pendingLabel?: string;
  tone?: "primary" | "danger" | "accent";
  /** Exact text the user has to type first (the name of what is deleted). */
  confirmText?: string;
  children?: ReactNode;
}

/**
 * A form whose submission is guarded by a confirmation dialog. `fields`
 * become hidden inputs and `action` runs once the dialog is confirmed, so a
 * server action can be passed straight from a server component; the
 * dispatcher of `useActionState` works too. The trigger gets an `open`
 * callback and the form's pending state; the dialog closes on its own when
 * the action has finished.
 */
export function ConfirmForm({
  action,
  fields,
  trigger,
  className,
  ...dialog
}: Dialog & {
  action: (formData: FormData) => void | Promise<void>;
  fields: Record<string, string>;
  trigger: (open: () => void, pending: boolean) => ReactNode;
  className?: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <form ref={formRef} action={action} className={className}>
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Guard trigger={trigger} dialog={dialog} submit={() => formRef.current?.requestSubmit()} />
    </form>
  );
}

/** Lives inside the form so it can read the form's pending state. */
function Guard({ trigger, dialog, submit }: { trigger: (open: () => void, pending: boolean) => ReactNode; dialog: Dialog; submit: () => void }) {
  const { pending } = useFormStatus();
  const [open, setOpen] = useState(false);
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending) setOpen(false);
    wasPending.current = pending;
  }, [pending]);
  const { confirmLabel, pendingLabel, tone = "danger", children, ...rest } = dialog;
  return (
    <>
      {trigger(() => setOpen(true), pending)}
      <ConfirmModal
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={submit}
        busy={pending}
        tone={tone}
        confirmLabel={pending ? (pendingLabel ?? confirmLabel) : confirmLabel}
        {...rest}
      >
        {children}
      </ConfirmModal>
    </>
  );
}
