#!/usr/bin/env tsx
/**
 * Emit the Vailmarch showcase campaign (`dev-vault/Campaigns/Vailmarch/`) from
 * the single geometry source `src/gen/testkit/vailmarch.ts`:
 *
 *   npx tsx scripts/emit-vailmarch-campaign.ts
 *
 * Writes Vailmarch.map.md, Fabric.geojson (MAP-UNIT coordinates), Generated.json
 * (empty — every request is a city-tier procgen block on a fabric feature) and
 * the location notes. Deterministic: same builders ⇒ same bytes, so re-running
 * after a fixture change is the whole "update the campaign" story. Dev tooling
 * only (node:fs is fine here — the Vault-API rule governs plugin runtime code);
 * never touches any other campaign.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildVailmarchFabric,
  VAILMARCH_BASE,
  VAILMARCH_BOUNDS,
  VAILMARCH_CAMPAIGN_SEED,
  VAILMARCH_MAP_ID,
  VAILMARCH_PINS,
  VAILMARCH_SCALE_M_PER_UNIT,
} from "../src/gen/testkit/vailmarch";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CAMPAIGN_DIR = join(REPO_ROOT, "dev-vault", "Campaigns", "Vailmarch");
const LOCATIONS_DIR = join(CAMPAIGN_DIR, "Locations");

function mapNote(): string {
  const [minX, minY, maxX, maxY] = VAILMARCH_BOUNDS;
  return `---
map-campaign: true
crs: fictional
theme: parchment
seed: ${VAILMARCH_CAMPAIGN_SEED}
scaleMetersPerUnit: ${VAILMARCH_SCALE_M_PER_UNIT}
bounds: [${minX}, ${minY}, ${maxX}, ${maxY}]
terrain:
  campAmp: ${VAILMARCH_BASE.campAmp}
  seaDatum: ${VAILMARCH_BASE.seaDatum}
---

# Vailmarch — the showcase march

A river-valley march built to show the terrain + coupling pipeline (plans
031–039) working together. Coastal lowland and sea in the WEST, a relief SPINE
(ridge stamps — no mountain polygons) across the NORTH with two arms reaching
south, a raised plateau in the EAST, a lake basin in the SOUTH. The river Vail
rises in the spine, carves a gorge through the ridge, and runs to the coast
gathering two tributaries. Every feature is generated from
\`src/gen/testkit/vailmarch.ts\`; regenerate this directory with
\`npx tsx scripts/emit-vailmarch-campaign.ts\` (never hand-edit — edits are
overwritten). 1 map unit = ${VAILMARCH_SCALE_M_PER_UNIT} m, so the valley is ~8 × 6 km.

Terrain is GLOBAL and ON (ruling 2026-07-15 — a mountain is just one stamp kind
of the composed terrain field). The persisted \`terrain\` block above turns the
continental base fBm on (\`campAmp: ${VAILMARCH_BASE.campAmp}\` m, sea datum
${VAILMARCH_BASE.seaDatum}); on top of it the durable stamps in \`Fabric.geojson\`
add the dramatic local relief — four \`relief\` lines (the Marchspine ridge, the
Cairn + Haward arms, the Vail valley) and three \`landform\` polygons (Eastmarch
plateau, Merewater basin, the Cold Reach sea) — plus the Vail's gorge CARVE.
There are NO mountain polygons: the forest timberline, the paddy contours, and
the flank pasture all read this global surface. Every ring is drawn with organic
(seeded-jittered) boundaries, not axis-aligned boxes.

Coupling tour (open in the playground or the app):
- Vailmarch: wall water-gate + moat leat on the waterfront, market-pin plaza,
  nested Kingsmoot Green, the East Road forcing gates through the ring.
- Twinbridge + Eastwool: adjacent districts sharing a wall/edge (bit-matched
  stubs, on the organic shared boundary), different profiles.
- The Vail: gorge carve through the Marchspine, Strahler width steps below the
  two confluences; Torrent Beck rises in the raised head of the valley.
- Cairnwood: conifer stands + timberline over the Cairn Arm ridge; Cairnfoot
  paddy terraces read the same relief; Hoarfell pasture slope-gates on the Haward
  Arm.
- Riverine strips + water meadows on the Marn; hedgerows where Hollowbrake meets
  Merewood Common and the crofts.
`;
}

function locationNote(pin: (typeof VAILMARCH_PINS)[number]): string {
  const ux = pin.point[0] / VAILMARCH_SCALE_M_PER_UNIT;
  const uy = pin.point[1] / VAILMARCH_SCALE_M_PER_UNIT;
  const lines = [
    "---",
    `map: ${VAILMARCH_MAP_ID}`,
    `geometry: [${ux}, ${uy}]`,
    ...(pin.type !== undefined ? [`type: ${pin.type}`] : []),
    ...(pin.visibility !== undefined ? [`visibility: ${pin.visibility}`] : []),
    "---",
    pin.body,
    "",
  ];
  return lines.join("\n");
}

function main(): void {
  mkdirSync(LOCATIONS_DIR, { recursive: true });

  writeFileSync(join(CAMPAIGN_DIR, "Vailmarch.map.md"), mapNote());
  writeFileSync(
    join(CAMPAIGN_DIR, "Fabric.geojson"),
    JSON.stringify(buildVailmarchFabric(), null, 2) + "\n"
  );
  // No world-tier requests — every request is a city-tier procgen block on a
  // fabric feature.
  writeFileSync(join(CAMPAIGN_DIR, "Generated.json"), JSON.stringify({ entries: [], domains: [] }, null, 2) + "\n");
  for (const pin of VAILMARCH_PINS) {
    writeFileSync(join(LOCATIONS_DIR, `${pin.name}.md`), locationNote(pin));
  }

  const fabric = buildVailmarchFabric();
  console.log(
    `Vailmarch campaign emitted: ${fabric.features.length} fabric features, ${VAILMARCH_PINS.length} location notes → ${CAMPAIGN_DIR}`
  );
}

main();
