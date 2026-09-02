import { clsx } from "clsx";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "accent";
type Size = "sm" | "md";

const variants: Record<Variant, string> = {
  primary:
    "bg-action text-action-ink hover:bg-action-hover border border-transparent shadow-sm",
  secondary:
    "bg-card text-ink border border-line-2 hover:bg-card-2 hover:border-ink-3",
  ghost: "bg-transparent text-ink-2 hover:text-ink hover:bg-card-2 border border-transparent",
  danger: "bg-danger text-white hover:opacity-90 border border-transparent",
  accent: "bg-accent text-white hover:opacity-90 border border-transparent shadow-sm",
};

const sizes: Record<Size, string> = {
  // Touch screens get taller hit targets; the widths stay the same.
  sm: "h-8 px-3 text-[13px] gap-1.5 pointer-coarse:h-9",
  md: "h-9.5 px-4 text-sm gap-2 pointer-coarse:h-10",
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
}) {
  return (
    <button
      className={clsx(
        "inline-flex items-center justify-center rounded-lg font-medium transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function buttonClasses(variant: Variant = "primary", size: Size = "md", extra?: string) {
  return clsx(
    "inline-flex items-center justify-center rounded-lg font-medium transition-colors whitespace-nowrap",
    variants[variant],
    sizes[size],
    extra,
  );
}
