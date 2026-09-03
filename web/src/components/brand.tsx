import { clsx } from "clsx";

// Brand mark: a chicory blossom — eight ligulate rays with the toothed tips
// the flower is known for, around a small disc. Drawn to stay legible at 16px.
const RAY =
  "M11.2 8.8C10.3 7.2 10.1 5 10.5 3.2L11.25 2 12 3.2 12.75 2 13.5 3.2C13.9 5 13.7 7.2 12.8 8.8Z";

export function Chicory({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <g fill="currentColor">
        {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
          <path key={deg} d={RAY} transform={`rotate(${deg} 12 12)`} />
        ))}
        <circle cx="12" cy="12" r="1.6" />
      </g>
    </svg>
  );
}

/** Instance identity for the shell: the uploaded logo when one is set, else the blossom. */
export interface BrandProps {
  name: string;
  logoDataUrl?: string;
}

/** The mark alone: an uploaded logo (data URL) or the blossom in brand colour. */
export function BrandMark({ logoDataUrl, className }: { logoDataUrl?: string; className?: string }) {
  if (logoDataUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- inline data URL, no optimisation possible
    return <img src={logoDataUrl} alt="" className={clsx("shrink-0 object-contain", className)} />;
  }
  return <Chicory className={clsx("shrink-0 text-brand", className)} />;
}

/** Mark + name, sized for the sidebar/header ("md") or the auth screens ("lg"). */
export function BrandLockup({ name, logoDataUrl, size = "md" }: BrandProps & { size?: "sm" | "md" | "lg" }) {
  const mark = size === "lg" ? "size-7" : size === "sm" ? "size-5" : "size-6";
  const text =
    size === "lg" ? "font-display text-xl font-bold tracking-tight" : size === "sm" ? "font-display text-[17px] font-bold tracking-tight" : "font-display text-lg font-bold tracking-tight";
  return (
    <>
      <BrandMark logoDataUrl={logoDataUrl} className={mark} />
      <span className={clsx("truncate", text)}>{name}</span>
    </>
  );
}
