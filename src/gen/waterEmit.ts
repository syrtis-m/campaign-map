/**
 * Shared water-feature emitters. Extracted from the river generator so the PARK
 * generator can reuse them at pond scale WITHOUT importing the river generator;
 * `river.ts` imports `q`/`quad` from here too.
 *
 * Pure/headless (no DOM/map/Obsidian imports; reads only its arguments).
 * Every coordinate is mm-quantized (D5); every feature id hashes on POSITION
 * (never emission order), integer so `clipNetworkToTile`'s `Number(id)` stays
 * stable (D2).
 */
import { hashSeed, mulberry32 } from "./rng";

type Pt = [number, number];

/** D5 coordinate quantization: millimeter lattice. */
export function q(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * A quad polygon feature from four corners (channel/island in the river; bridge
 * spans + any 4-corner water shape in the park). Id hashes the a→c diagonal
 * endpoints (position, never emission order); integer so `Number(id)` sorts
 * deterministically in the tile clip.
 */
export function quad(seed: number, gid: string, a: Pt, b: Pt, c: Pt, d: Pt): GeoJSON.Feature {
  const ring: Pt[] = [
    [q(a[0]), q(a[1])],
    [q(b[0]), q(b[1])],
    [q(c[0]), q(c[1])],
    [q(d[0]), q(d[1])],
    [q(a[0]), q(a[1])],
  ];
  return {
    type: "Feature",
    id: hashSeed(seed, gid, q(a[0]), q(a[1]), q(c[0]), q(c[1])),
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: { generatorId: gid, type: gid },
  };
}

/**
 * A seeded harmonic-radius blob ring (the same closed-form trick as the
 * meander, NOT a smooth-min SDF). The radius at
 * angle θ is `baseR · (1 + Σ aₖ·sin(kθ + φₖ))` for a few low harmonics whose
 * amplitudes/phases hash on `(seed, salt)` — so a pond is deterministic, keyed
 * only on its anchor's seed, and re-rolls with a new seed. Returned CCW and
 * closed (first === last), mm-quantized. `irregularity` (0..1) scales the total
 * harmonic amplitude; `lobes` sets how many harmonics contribute.
 */
export function harmonicBlobRing(
  seed: number,
  salt: string,
  cx: number,
  cy: number,
  baseR: number,
  irregularity: number,
  lobes = 3,
  steps = 48
): Pt[] {
  const rng = mulberry32(hashSeed(seed, salt));
  // Per-harmonic amplitude + phase, drawn once (deterministic per seed/salt).
  const harmonics: { k: number; amp: number; phi: number }[] = [];
  let ampSum = 0;
  for (let h = 0; h < lobes; h++) {
    const k = 2 + h; // start at 2 lobes so the blob is never a plain ellipse
    const amp = (0.28 / (h + 1)) * irregularity;
    ampSum += amp;
    harmonics.push({ k, amp, phi: rng() * Math.PI * 2 });
  }
  // Clamp so the radius can never go non-positive (a self-touching blob).
  const scale = ampSum > 0.85 ? 0.85 / ampSum : 1;
  const ring: Pt[] = [];
  for (let i = 0; i < steps; i++) {
    const theta = (i / steps) * Math.PI * 2;
    let r = 1;
    for (const { k, amp, phi } of harmonics) r += amp * scale * Math.sin(k * theta + phi);
    ring.push([q(cx + Math.cos(theta) * baseR * r), q(cy + Math.sin(theta) * baseR * r)]);
  }
  ring.push([ring[0][0], ring[0][1]]);
  return ring;
}

/** A closed-ring polygon feature (pond/island), id hashed on its anchor.
 * Quantizes every vertex (D5) and re-closes on the quantized first vertex —
 * idempotent for pre-quantized rings, a sub-mm snap for raw ones. */
export function blobFeature(
  seed: number,
  gid: string,
  ring: Pt[],
  extraProps: Record<string, unknown> = {}
): GeoJSON.Feature {
  const quantized: Pt[] = ring.map(([x, y]) => [q(x), q(y)] as Pt);
  quantized[quantized.length - 1] = [quantized[0][0], quantized[0][1]];
  return {
    type: "Feature",
    id: hashSeed(seed, gid, quantized[0][0], quantized[0][1], quantized.length),
    geometry: { type: "Polygon", coordinates: [quantized] },
    properties: { generatorId: gid, type: gid, ...extraProps },
  };
}

/**
 * A bridge span: a rectangle of half-width `hw` centred on the segment a→b
 * (a short deck where a path crosses water). Reuses `quad`, so
 * the id/quantization discipline is shared. `extraProps` merge onto properties.
 */
export function spanQuad(
  seed: number,
  gid: string,
  a: Pt,
  b: Pt,
  hw: number,
  extraProps: Record<string, unknown> = {}
): GeoJSON.Feature {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  const nx = -dy / l;
  const ny = dx / l;
  const f = quad(
    seed,
    gid,
    [a[0] + nx * hw, a[1] + ny * hw],
    [b[0] + nx * hw, b[1] + ny * hw],
    [b[0] - nx * hw, b[1] - ny * hw],
    [a[0] - nx * hw, a[1] - ny * hw]
  );
  Object.assign(f.properties as Record<string, unknown>, extraProps);
  return f;
}
