---
map-campaign: true
crs: fictional
theme: parchment
seed: 48157
scaleMetersPerUnit: 500
bounds: [-9, -6, 8, 6]
terrain:
  campAmp: 220
  seaDatum: 0
---

# Vailmarch — the showcase march

A river-valley march built to show the terrain + coupling pipeline (plans
031–039) working together. Coastal lowland and sea in the WEST, a relief SPINE
(ridge stamps — no mountain polygons) across the NORTH with two arms reaching
south, a raised plateau in the EAST, a lake basin in the SOUTH. The river Vail
rises in the spine, carves a gorge through the ridge, and runs to the coast
gathering two tributaries. Every feature is generated from
`src/gen/testkit/vailmarch.ts`; regenerate this directory with
`npx tsx scripts/emit-vailmarch-campaign.ts` (never hand-edit — edits are
overwritten). 1 map unit = 500 m, so the valley is ~8 × 6 km.

Terrain is GLOBAL and ON (ruling 2026-07-15 — a mountain is just one stamp kind
of the composed terrain field). The persisted `terrain` block above turns the
continental base fBm on (`campAmp: 220` m, sea datum
0); on top of it the durable stamps in `Fabric.geojson`
add the dramatic local relief — four `relief` lines (the Marchspine ridge, the
Cairn + Haward arms, the Vail valley) and three `landform` polygons (Eastmarch
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
