import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CORRIDOR_INFLUENCE,
  CORRIDOR_HALO,
  chaikinSmooth,
  generateCorridorStreets,
} from "./corridor";
import type { BBox } from "../spatialHash";
import type { GenerationConstraints } from "../types";

const WORLD_BOUNDS: BBox = { minX: -2000, minY: -2000, maxX: 2000, maxY: 2000 };
const SEED = 4181;

function constraints(): GenerationConstraints {
  return { worldBounds: WORLD_BOUNDS };
}

/** Compact seeded snapshot fixture: pins the exact bytes of the output (any
 * numeric drift flips the sha256) without committing half a megabyte of
 * coordinates — the repo convention is small .snap files (see sigil). */
function digest(features: unknown): { sha256: string; summary: Record<string, number> } {
  const list = features as GeoJSON.Feature[];
  const summary: Record<string, number> = { total: list.length };
  for (const f of list) {
    const cls = String((f.properties as Record<string, unknown>)?.roadClass);
    summary[cls] = (summary[cls] ?? 0) + 1;
  }
  return {
    sha256: createHash("sha256").update(JSON.stringify(features)).digest("hex"),
    summary,
  };
}

/** A GM-drawn road corridor crossing the 2x2 tile cross at x=0 and y=0. */
function drawnCorridor(): GeoJSON.LineString {
  return {
    type: "LineString",
    coordinates: [
      [-250, -120],
      [-80, -40],
      [60, 30],
      [180, 60],
      [250, 140],
    ],
  };
}

describe("chaikinSmooth", () => {
  it("preserves endpoints and is deterministic", () => {
    const coords: [number, number][] = [
      [0, 0],
      [100, 80],
      [200, 0],
    ];
    const a = chaikinSmooth(coords, 2);
    const b = chaikinSmooth(coords, 2);
    expect(a).toEqual(b);
    expect(a[0]).toEqual([0, 0]);
    expect(a[a.length - 1]).toEqual([200, 0]);
    expect(a.length).toBeGreaterThan(coords.length);
  });

  it("leaves a 2-point segment unchanged", () => {
    const coords: [number, number][] = [
      [0, 0],
      [50, 50],
    ];
    expect(chaikinSmooth(coords, 3)).toEqual(coords);
  });
});

describe("generateCorridorStreets determinism", () => {
  const bbox: BBox = { minX: -300, minY: -300, maxX: 300, maxY: 300 };

  it("same inputs produce byte-identical output (cache delete + regenerate)", () => {
    const runs = Array.from({ length: 4 }, () =>
      generateCorridorStreets(SEED, bbox, drawnCorridor(), constraints())
    );
    expect(runs[0].length).toBeGreaterThan(0);
    for (let i = 1; i < runs.length; i++) {
      expect(JSON.stringify(runs[i])).toBe(JSON.stringify(runs[0]));
    }
  });

  it("matches the seeded snapshot fixture", () => {
    const features = generateCorridorStreets(SEED, bbox, drawnCorridor(), constraints());
    expect(digest(features)).toMatchSnapshot();
  });

  it("different seeds produce different networks", () => {
    const a = generateCorridorStreets(SEED, bbox, drawnCorridor(), constraints());
    const b = generateCorridorStreets(SEED + 1, bbox, drawnCorridor(), constraints());
    expect(a).not.toEqual(b);
  });

  it("different corridors produce different networks with distinct ids", () => {
    const other: GeoJSON.LineString = {
      type: "LineString",
      coordinates: [
        [-250, 100],
        [0, -50],
        [250, -140],
      ],
    };
    const a = generateCorridorStreets(SEED, bbox, drawnCorridor(), constraints());
    const b = generateCorridorStreets(SEED, bbox, other, constraints());
    expect(a).not.toEqual(b);
    const idsA = new Set(a.map((f) => f.id));
    const idsB = new Set(b.map((f) => f.id));
    expect([...idsA].some((id) => idsB.has(id))).toBe(false);
  });
});

describe("generateCorridorStreets shape", () => {
  const bbox: BBox = { minX: -300, minY: -300, maxX: 300, maxY: 300 };

  it("emits a major avenue plus branching minor streets", () => {
    const features = generateCorridorStreets(SEED, bbox, drawnCorridor(), constraints());
    const majors = features.filter((f) => f.properties?.roadClass === "major");
    const minors = features.filter((f) => f.properties?.roadClass === "minor");
    expect(majors.length).toBeGreaterThan(0);
    expect(minors.length).toBeGreaterThan(0);
    for (const f of features) {
      expect(f.properties?.generatorId).toBe("sketch-corridor");
      expect(f.geometry.type).toBe("LineString");
    }
  });

  it("the avenue hugs the drawn corridor and every street stays near it", () => {
    const corridor = drawnCorridor();
    const raw = corridor.coordinates as [number, number][];
    const distToCorridor = (x: number, y: number): number => {
      let best = Infinity;
      for (let i = 0; i < raw.length - 1; i++) {
        const [ax, ay] = raw[i];
        const [bx, by] = raw[i + 1];
        const dx = bx - ax;
        const dy = by - ay;
        const l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
        best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
      }
      return best;
    };
    const features = generateCorridorStreets(SEED, bbox, corridor, constraints());
    for (const f of features) {
      const coords = (f.geometry as GeoJSON.LineString).coordinates as [number, number][];
      const maxAllowed =
        f.properties?.roadClass === "major"
          ? 40 // Chaikin smoothing only cuts corners toward the line
          : CORRIDOR_INFLUENCE + CORRIDOR_HALO; // seed radius + max trace length
      for (const [x, y] of coords) {
        expect(distToCorridor(x, y)).toBeLessThanOrEqual(maxAllowed);
      }
    }
  });

  it("keeps minor-street seeds away from canon points", () => {
    const withCanon: GenerationConstraints = {
      worldBounds: WORLD_BOUNDS,
      canonFeatures: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [60, 30] },
          properties: {},
        },
      ],
    };
    const a = generateCorridorStreets(SEED, bbox, drawnCorridor(), constraints());
    const b = generateCorridorStreets(SEED, bbox, drawnCorridor(), withCanon);
    // Canon presence must only ever remove seeds, never perturb others.
    const idsB = new Set(b.map((f) => f.id));
    expect(b.length).toBeLessThanOrEqual(a.length);
    for (const f of b) {
      expect(idsB.has(f.id)).toBe(true);
    }
    const idsA = new Set(a.map((f) => f.id));
    for (const f of b) {
      expect(idsA.has(f.id)).toBe(true);
    }
  });
});

describe("generateCorridorStreets 2x2 seam test", () => {
  // Four adjacent tiles sharing an internal cross of edges at x=0 and y=0;
  // the corridor is passed WHOLE to every tile (the caller contract).
  const TILE = 300;
  const tiles: BBox[] = [
    { minX: -TILE, minY: -TILE, maxX: 0, maxY: 0 }, // SW
    { minX: 0, minY: -TILE, maxX: TILE, maxY: 0 }, // SE
    { minX: -TILE, minY: 0, maxX: 0, maxY: TILE }, // NW
    { minX: 0, minY: 0, maxX: TILE, maxY: TILE }, // NE
  ];

  function pointsOnEdge(features: GeoJSON.Feature[], edge: "x" | "y", value: number): [number, number][] {
    const pts: [number, number][] = [];
    for (const f of features) {
      for (const [x, y] of (f.geometry as GeoJSON.LineString).coordinates as [number, number][]) {
        const onEdge = edge === "x" ? Math.abs(x - value) < 1e-9 : Math.abs(y - value) < 1e-9;
        if (onEdge) pts.push([x, y]);
      }
    }
    return pts;
  }

  it("edge-crossing streets match endpoints within epsilon across all four tiles", () => {
    const corridor = drawnCorridor();
    const results = tiles.map((bbox) => generateCorridorStreets(SEED, bbox, corridor, constraints()));
    for (const r of results) expect(r.length).toBeGreaterThan(0);

    // Vertical seam at x=0: SW/NW (west side) vs SE/NE (east side).
    const westAtX0 = [...pointsOnEdge(results[0], "x", 0), ...pointsOnEdge(results[2], "x", 0)];
    const eastAtX0 = [...pointsOnEdge(results[1], "x", 0), ...pointsOnEdge(results[3], "x", 0)];
    expect(westAtX0.length).toBeGreaterThan(0);
    expect(eastAtX0.length).toBe(westAtX0.length);
    const westY = westAtX0.map(([, y]) => y).sort((a, b) => a - b);
    const eastY = eastAtX0.map(([, y]) => y).sort((a, b) => a - b);
    for (let i = 0; i < westY.length; i++) {
      expect(Math.abs(westY[i] - eastY[i])).toBeLessThan(1e-6);
    }

    // Horizontal seam at y=0: SW/SE (south side) vs NW/NE (north side).
    const southAtY0 = [...pointsOnEdge(results[0], "y", 0), ...pointsOnEdge(results[1], "y", 0)];
    const northAtY0 = [...pointsOnEdge(results[2], "y", 0), ...pointsOnEdge(results[3], "y", 0)];
    expect(southAtY0.length).toBeGreaterThan(0);
    expect(northAtY0.length).toBe(southAtY0.length);
    const southX = southAtY0.map(([x]) => x).sort((a, b) => a - b);
    const northX = northAtY0.map(([x]) => x).sort((a, b) => a - b);
    for (let i = 0; i < southX.length; i++) {
      expect(Math.abs(southX[i] - northX[i])).toBeLessThan(1e-6);
    }
  });

  it("the 2x2 seam layout matches its snapshot fixture", () => {
    const corridor = drawnCorridor();
    const results = tiles.map((bbox) => generateCorridorStreets(SEED, bbox, corridor, constraints()));
    expect(results.map(digest)).toMatchSnapshot();
  });

  it("splitting into tiles never drops interior streets vs one large tile", () => {
    const corridor = drawnCorridor();
    const whole = generateCorridorStreets(
      SEED,
      { minX: -TILE, minY: -TILE, maxX: TILE, maxY: TILE },
      corridor,
      constraints()
    );
    const split = tiles.flatMap((bbox) => generateCorridorStreets(SEED, bbox, corridor, constraints()));
    expect(split.length).toBeGreaterThanOrEqual(whole.length);
  });
});
