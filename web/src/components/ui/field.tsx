import { clsx } from "clsx";
import type { InputHTMLAttributes, ReactNode, Ref, TextareaHTMLAttributes } from "react";

export function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-[13px] font-medium text-ink">
      {children}
    </label>
  );
}

const inputClasses =
  // 16px on phones: anything smaller makes iOS zoom the page when a field is focused.
  "w-full rounded-lg border border-line-2 bg-card px-3 py-2 text-base text-ink placeholder:text-ink-3 focus:border-action focus:outline-none focus:ring-2 focus:ring-action/15 disabled:opacity-60 sm:text-sm";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input className={clsx(inputClasses, className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={clsx(inputClasses, "min-h-20", className)} {...props} />;
}

/**
 * Wraps a button that sits beside Fields in a top-aligned row
 * (`flex items-start`): it reserves the label's height, so the control lines
 * up with the inputs no matter which field carries a hint or a textarea.
 * Rows aligned with `items-end` break as soon as one field has a footnote.
 */
export function FieldAction({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx("flex flex-col", className)}>
      <span aria-hidden className="mb-1.5 block select-none text-[13px] font-medium opacity-0 max-sm:hidden">
        &nbsp;
      </span>
      {children}
    </div>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="mt-1.5 text-xs text-ink-2">{hint}</p>}
    </div>
  );
}
