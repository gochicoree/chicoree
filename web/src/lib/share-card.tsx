// The preview image behind every share link (1200×630): rendered on demand
// by the opengraph-image routes with next/og (satori + resvg). Fonts are the
// site's own, vendored as WOFF under lib/share/fonts because the renderer
// cannot read the WOFF2 files the pages load.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { RAY } from "@/components/brand";
import type { ShareInstance } from "./share";

export const CARD_SIZE = { width: 1200, height: 630 };

const paper = "#f2f5f6";
const ink = "#16272f";
const ink2 = "#5c707b";
const ink3 = "#8a9aa3";
const well = "#e6ecef";

const FONT_DIR = join(process.cwd(), "src/lib/share/fonts");
type Font = { name: string; data: Buffer; weight: 400 | 600 | 700; style: "normal" };
let fontsPromise: Promise<Font[]> | null = null;

function loadFonts(): Promise<Font[]> {
  fontsPromise ??= Promise.all([
    readFile(join(FONT_DIR, "bricolage-grotesque-700.woff")),
    readFile(join(FONT_DIR, "public-sans-400.woff")),
    readFile(join(FONT_DIR, "public-sans-600.woff")),
    readFile(join(FONT_DIR, "jetbrains-mono-400.woff")),
  ]).then(([display, body, bodyBold, mono]) => [
    { name: "Bricolage Grotesque", data: display, weight: 700, style: "normal" },
    { name: "Public Sans", data: body, weight: 400, style: "normal" },
    { name: "Public Sans", data: bodyBold, weight: 600, style: "normal" },
    { name: "JetBrains Mono", data: mono, weight: 400, style: "normal" },
  ]);
  return fontsPromise;
}

/** The chicory blossom as an SVG data URL in the accent colour (the renderer draws images, not inline SVG, reliably). */
export function blossomDataUrl(accent: string): string {
  const rays = [0, 45, 90, 135, 180, 225, 270, 315].map((deg) => `<path d="${RAY}" transform="rotate(${deg} 12 12)"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g fill="${accent}">${rays}<circle cx="12" cy="12" r="1.6"/></g></svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

export interface CardProps {
  instance: ShareInstance;
  /** Small label next to the instance name: "Container image", "Organization", … */
  eyebrow?: string;
  title: string;
  subtitle?: string;
  stats?: { label: string; value: string }[];
  /** A shell line, drawn in the mono font with a prompt. */
  command?: string;
  /** Picture of the thing itself (repository, organization), as a drawable data URL. */
  picture?: string | null;
  /** Relative widths of the decorative layer strata on the right. */
  strata?: number[];
}

/** Deterministic strata for a name, so the same repository always gets the same silhouette. */
export function strataFor(seed: string, count = 8): number[] {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    out.push(28 + (h % 73));
  }
  return out;
}

function titleSize(title: string): number {
  if (title.length <= 16) return 84;
  if (title.length <= 24) return 68;
  if (title.length <= 34) return 54;
  return 42;
}

function Card({ instance, eyebrow, title, subtitle, stats, command, picture, strata }: CardProps) {
  const mark = instance.logoDataUrl ?? blossomDataUrl(instance.accent);
  const bars = strata ?? strataFor(title);
  return (
    <div style={{ width: 1200, height: 630, display: "flex", background: paper, color: ink, fontFamily: "Public Sans", position: "relative" }}>
      <div style={{ position: "absolute", right: 56, top: 0, bottom: 0, width: 220, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "flex-end", gap: 12 }}>
        {bars.map((w, i) => (
          <div key={i} style={{ height: 26, width: `${w}%`, background: instance.accent, opacity: 0.1 + (i % 3) * 0.07, borderRadius: 5 }} />
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "52px 56px", width: 900, height: 630 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <img src={mark} width={40} height={40} style={{ objectFit: "contain" }} />
          <span style={{ fontFamily: "Bricolage Grotesque", fontWeight: 700, fontSize: 30, letterSpacing: -0.5 }}>{instance.name}</span>
          {eyebrow && (
            <span style={{ marginLeft: 6, padding: "5px 14px", border: `2px solid ${ink3}`, borderRadius: 999, fontSize: 20, color: ink2 }}>{eyebrow}</span>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 26 }}>
            {picture && <img src={picture} width={96} height={96} style={{ borderRadius: 22, objectFit: "cover", background: well }} />}
            <div style={{ display: "flex", fontFamily: "Bricolage Grotesque", fontWeight: 700, fontSize: titleSize(title), lineHeight: 1.04, letterSpacing: -2, maxWidth: picture ? 660 : 790, overflow: "hidden" }}>
              {title}
            </div>
          </div>
          {subtitle && (
            <div style={{ display: "flex", fontSize: 30, lineHeight: 1.35, color: ink2, maxWidth: 800, overflow: "hidden" }}>{subtitle}</div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          {stats && stats.length > 0 && (
            <div style={{ display: "flex", gap: 56 }}>
              {stats.map((s) => (
                <div key={s.label} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontSize: 17, letterSpacing: 2.5, textTransform: "uppercase", color: ink3 }}>{s.label}</span>
                  <span style={{ fontSize: 36, fontWeight: 600, letterSpacing: -0.5 }}>{s.value}</span>
                </div>
              ))}
            </div>
          )}
          {command && (
            <div style={{ display: "flex", alignItems: "center", gap: 14, alignSelf: "flex-start", maxWidth: 820, padding: "14px 22px", background: well, borderRadius: 14, fontFamily: "JetBrains Mono", fontSize: 24, color: ink2, overflow: "hidden" }}>
              <span style={{ color: instance.accent }}>$</span>
              <span style={{ color: ink }}>{command}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Render a card; every opengraph-image route ends here. */
export async function shareCard(props: CardProps): Promise<ImageResponse> {
  return new ImageResponse(<Card {...props} />, { ...CARD_SIZE, fonts: await loadFonts() });
}
