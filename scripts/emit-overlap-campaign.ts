#!/usr/bin/env tsx
/**
 * Emit the Overlap test campaign (`dev-vault/Campaigns/Overlap/`) from the
 * single geometry source `src/gen/testkit/overlapMap.ts`:
 *
 *   npx tsx scripts/emit-overlap-campaign.ts
 *
 * Writes Overlap.map.md, Fabric.geojson, Generated.json (empty — no world-tier
 * requests) and the S8 location notes. Deterministic: same builders ⇒ same
 * bytes, so re-running after a fixture change is the whole "update the
 * campaign" story. Dev tooling only (node:fs is fine here — the Vault-API rule
 * governs plugin runtime code); never touches any other campaign.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildOverlapCampaignFabric,
  OVERLAP_BOUNDS,
  OVERLAP_CAMPAIGN_SEED,
  OVERLAP_MAP_ID,
  OVERLAP_PINS,
  OVERLAP_SCALE_M_PER_UNIT,
} from "../src/gen/testkit/overlapMap";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CAMPAIGN_DIR = join(REPO_ROOT, "dev-vault", "Campaigns", "Overlap");
const LOCATIONS_DIR = join(CAMPAIGN_DIR, "Locations");

function mapNote(): string {
  const [minX, minY, maxX, maxY] = OVERLAP_BOUNDS;
  return `---
map-campaign: true
crs: fictional
theme: obsidian-native
seed: ${OVERLAP_CAMPAIGN_SEED}
scaleMetersPerUnit: ${OVERLAP_SCALE_M_PER_UNIT}
bounds: [${minX}, ${minY}, ${maxX}, ${maxY}]
---

Overlap — the pipeline-arc fixture campaign (plans 031–039). Every feature is
generated from \`src/gen/testkit/overlapMap.ts\`; regenerate this directory with
\`npx tsx scripts/emit-overlap-campaign.ts\` (never hand-edit — edits are
overwritten). 1 map unit = ${OVERLAP_SCALE_M_PER_UNIT} m, so the world is ~2.4 × 2.4 km.

Scenarios (coupling matrix, plans/research-generation-pipeline.md §2):
S1 the Threadwater crosses Coppersquare · S2 the wall traces the district ring ·
S3 Fernside Wood over the upstream reach · S4 Quayside Fields share the east
edge + downstream river · S5 Wardmoot Green nested in the district · S6
Newquarter shares the south edge exactly · S7 the Greywatch near the river,
over the terraces · S8 canon pins (typed market + untyped boundary pins).
`;
}

function locationNote(pin: (typeof OVERLAP_PINS)[number]): string {
  const lines = [
    "---",
    `map: ${OVERLAP_MAP_ID}`,
    `geometry: [${pin.point[0]}, ${pin.point[1]}]`,
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

  writeFileSync(join(CAMPAIGN_DIR, "Overlap.map.md"), mapNote());
  writeFileSync(
    join(CAMPAIGN_DIR, "Fabric.geojson"),
    JSON.stringify(buildOverlapCampaignFabric(), null, 2) + "\n"
  );
  // No world-tier requests (city-tier requests live on the fabric features).
  writeFileSync(join(CAMPAIGN_DIR, "Generated.json"), JSON.stringify({ entries: [], domains: [] }, null, 2) + "\n");
  for (const pin of OVERLAP_PINS) {
    writeFileSync(join(LOCATIONS_DIR, `${pin.name}.md`), locationNote(pin));
  }

  const fabric = buildOverlapCampaignFabric();
  console.log(
    `Overlap campaign emitted: ${fabric.features.length} fabric features, ${OVERLAP_PINS.length} location notes → ${CAMPAIGN_DIR}`
  );
}

main();
