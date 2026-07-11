/**
 * Seeded SVG sigil composition (docs/03 Phase 3a) — mid location-art tier
 * between custom vault images and theme template icons (docs/02 §4).
 * Pure/headless: same seed → byte-identical SVG string, forever.
 */
import { mulberry32, pick } from "../rng";

export interface SigilOptions {
  size?: number;
  background?: string;
  foreground?: string;
}

const FRAME_SHAPES = ["circle", "shield", "hex"] as const;
const CHARGES = ["chevron", "ring", "diamond", "star", "cross", "bar", "wave"] as const;
const PALETTE = ["#7d1f1f", "#1a73e8", "#b8860b", "#2e7d32", "#4a3b28", "#8a2be2", "#c9302c", "#00695c"];

function frameShapePath(shape: (typeof FRAME_SHAPES)[number], size: number): string {
  const c = size / 2;
  switch (shape) {
    case "circle":
      return `<circle cx="${c}" cy="${c}" r="${c - 2}" />`;
    case "hex": {
      const r = c - 2;
      const pts = Array.from({ length: 6 }, (_, i) => {
        const a = Math.PI / 6 + i * (Math.PI / 3);
        return `${(c + r * Math.cos(a)).toFixed(2)},${(c + r * Math.sin(a)).toFixed(2)}`;
      }).join(" ");
      return `<polygon points="${pts}" />`;
    }
    case "shield": {
      const w = size - 8;
      const h = size - 6;
      const x0 = 4;
      const y0 = 3;
      return `<path d="M ${x0} ${y0} H ${x0 + w} V ${y0 + h * 0.55} Q ${x0 + w} ${y0 + h * 0.85} ${x0 + w / 2} ${y0 + h} Q ${x0} ${y0 + h * 0.85} ${x0} ${y0 + h * 0.55} Z" />`;
    }
  }
}

function chargePath(charge: (typeof CHARGES)[number], size: number): string {
  const c = size / 2;
  const r = size * 0.28;
  const sw = (size * 0.06).toFixed(2);
  switch (charge) {
    case "chevron":
      return `<path d="M ${c - r} ${c + r * 0.4} L ${c} ${c - r * 0.6} L ${c + r} ${c + r * 0.4}" fill="none" stroke-width="${sw}" />`;
    case "ring":
      return `<circle cx="${c}" cy="${c}" r="${(r * 0.6).toFixed(2)}" fill="none" stroke-width="${sw}" />`;
    case "diamond":
      return `<polygon points="${c},${c - r} ${c + r * 0.7},${c} ${c},${c + r} ${c - r * 0.7},${c}" />`;
    case "star": {
      const pts = Array.from({ length: 10 }, (_, i) => {
        const rad = i % 2 === 0 ? r : r * 0.42;
        const a = -Math.PI / 2 + i * (Math.PI / 5);
        return `${(c + rad * Math.cos(a)).toFixed(2)},${(c + rad * Math.sin(a)).toFixed(2)}`;
      }).join(" ");
      return `<polygon points="${pts}" />`;
    }
    case "cross":
      return `<path d="M ${c - r * 0.15} ${c - r} H ${c + r * 0.15} V ${c - r * 0.15} H ${c + r} V ${c + r * 0.15} H ${c + r * 0.15} V ${c + r} H ${c - r * 0.15} V ${c + r * 0.15} H ${c - r} V ${c - r * 0.15} H ${c - r * 0.15} Z" />`;
    case "bar":
      return `<rect x="${c - r}" y="${c - r * 0.18}" width="${r * 2}" height="${r * 0.36}" />`;
    case "wave":
      return `<path d="M ${c - r} ${c} Q ${c - r * 0.5} ${c - r * 0.5} ${c} ${c} Q ${c + r * 0.5} ${c + r * 0.5} ${c + r} ${c}" fill="none" stroke-width="${sw}" />`;
  }
}

/** `(seed) => svgString` — deterministic sigil, e.g. for a settlement or faction location. */
export function generateSigil(seed: number, opts: SigilOptions = {}): string {
  const size = opts.size ?? 64;
  const rng = mulberry32(seed);

  const frame = pick(rng, FRAME_SHAPES);
  const background = opts.background ?? pick(rng, PALETTE);
  const foregroundChoices = PALETTE.filter((c) => c !== background);
  const foreground = opts.foreground ?? (foregroundChoices.length > 0 ? pick(rng, foregroundChoices) : "#f2e8cf");

  const chargeCount = 1 + Math.floor(rng() * 2);
  const used = new Set<(typeof CHARGES)[number]>();
  const charges: string[] = [];
  for (let i = 0; i < chargeCount; i++) {
    let charge = pick(rng, CHARGES);
    let guard = 0;
    while (used.has(charge) && guard < 8) {
      charge = pick(rng, CHARGES);
      guard++;
    }
    used.add(charge);
    charges.push(chargePath(charge, size));
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">`,
    `<g fill="${background}" stroke="${foreground}" stroke-width="2">${frameShapePath(frame, size)}</g>`,
    `<g fill="${foreground}" stroke="${foreground}">${charges.join("")}</g>`,
    `</svg>`,
  ].join("");
}
