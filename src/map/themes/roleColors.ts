import type { ThemeTokens } from "./tokens";
import type { SemanticRole } from "../../gen/procgen/styleContract";

/**
 * The role→value map: each semantic paint role resolves to one per-theme fabric
 * token. This is the whole of a theme's say over generated fabric — the paint
 * builder reads colors only through here, so a new algorithm's buckets paint in
 * every theme with zero per-theme edits (they name roles, and every theme
 * already answers every role).
 *
 * A pure projection of `ThemeTokens`, so a role's value is byte-identical to the
 * token it names — moving color definitions here changes where they live, not
 * what they are. The two `??` fallbacks reproduce the sketched-fabric defaults
 * for the optional casing tokens (a theme without `fabricPathCasing` casings on
 * its wall stone; without `fabricWaterShore`, on its river hue).
 */
export type RoleColors = Record<SemanticRole, string>;

export function roleColorsForTheme(t: ThemeTokens): RoleColors {
  return {
    water: t.fabricRiver,
    "water-body": t.fabricWater,
    "water-edge": t.fabricWaterShore ?? t.fabricRiver,
    ground: t.land,
    vegetation: t.fabricPark,
    "vegetation-deep": t.fabricForest,
    cultivated: t.fabricFarmland,
    built: t.roadMinor,
    "built-accent": t.fabricDistrict,
    route: t.fabricRoad,
    boundary: t.fabricWall,
    "path-casing": t.fabricPathCasing ?? t.fabricWall,
    relief: t.fabricMountain,
    accent: t.accent,
  };
}
