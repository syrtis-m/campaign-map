/**
 * Base-terrain settings normalization (plan 036-D).
 *
 * The campaign config carries an OPTIONAL `terrain` block —
 * `{ campAmp, seaDatum, grade }` — that drives the composed elevation field
 * (`terrainAt`) and thus the DEM (hillshade + 3D). It landed engine-first with
 * no UI; the campaign-settings modal now edits it behind an explicit Apply
 * (never a live slider — a base-param change re-derives every DEM tile, a real
 * cost). This module is the pure, headlessly-testable core: it validates and
 * normalizes the three fields, and drops the block entirely when it is all
 * defaults so frontmatter stays minimal (the same "unset = default" discipline
 * as naming cultures).
 */

/** The persisted config block shape (mirrors campaignConfig's optional field). */
export interface TerrainBlock {
  campAmp: number;
  seaDatum: number;
  grade: boolean;
}

/** Inert defaults: flat base at datum 0, city grading off. Identical to the
 * absent-block behavior in MapController.terrainBase(). */
export const TERRAIN_DEFAULTS: TerrainBlock = { campAmp: 0, seaDatum: 0, grade: false };

function isDefault(block: TerrainBlock): boolean {
  return (
    block.campAmp === TERRAIN_DEFAULTS.campAmp &&
    block.seaDatum === TERRAIN_DEFAULTS.seaDatum &&
    block.grade === TERRAIN_DEFAULTS.grade
  );
}

/**
 * Normalize raw UI input into a persistable block, or `undefined` when every
 * field is at its default (⇒ delete the frontmatter key). `campAmp` is clamped
 * non-negative (a negative continental amplitude is meaningless); non-finite
 * numbers fall back to the default for that field.
 */
export function normalizeTerrainBlock(input: {
  campAmp?: number;
  seaDatum?: number;
  grade?: boolean;
}): TerrainBlock | undefined {
  const campAmp = Number.isFinite(input.campAmp)
    ? Math.max(0, input.campAmp as number)
    : TERRAIN_DEFAULTS.campAmp;
  const seaDatum = Number.isFinite(input.seaDatum) ? (input.seaDatum as number) : TERRAIN_DEFAULTS.seaDatum;
  const grade = input.grade === true;
  const block: TerrainBlock = { campAmp, seaDatum, grade };
  return isDefault(block) ? undefined : block;
}

/** The current block for the editor, filling defaults for any absent field. */
export function terrainBlockOrDefaults(block: Partial<TerrainBlock> | undefined): TerrainBlock {
  return {
    campAmp: block?.campAmp ?? TERRAIN_DEFAULTS.campAmp,
    seaDatum: block?.seaDatum ?? TERRAIN_DEFAULTS.seaDatum,
    grade: block?.grade ?? TERRAIN_DEFAULTS.grade,
  };
}
