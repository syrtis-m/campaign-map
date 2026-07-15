---
map-campaign: true
crs: fictional
theme: parchment
seed: 48157
scaleMetersPerUnit: 500
bounds: [-9, -6, 8, 6]
---

# Vailmarch — the showcase march

A river-valley march built to show the terrain + coupling pipeline (plans
031–039) working together. Coastal lowland and sea in the WEST, a mountain spine
across the NORTH, a raised plateau in the EAST, a lake basin in the SOUTH. The
river Vail rises in the spine, carves a gorge through the ridge, and runs to the
coast gathering two tributaries. Every feature is generated from
`src/gen/testkit/vailmarch.ts`; regenerate this directory with
`npx tsx scripts/emit-vailmarch-campaign.ts` (never hand-edit — edits are
overwritten). 1 map unit = 500 m, so the valley is ~8 × 6 km.

Terrain is ON through the durable stamps in `Fabric.geojson` — two `relief`
lines (the Marchspine ridge, the Vail valley), two `mountain` massifs, and three
`landform` polygons (Eastmarch plateau, Merewater basin, the Cold Reach sea) —
plus the Vail's gorge CARVE. (Base fBm amplitude `campAmp` is NOT persistable in
campaign frontmatter today — plan 036-D's Apply UI is deferred — so the base
stays flat and the visible relief comes entirely from the stamps.)

Coupling tour (open in the playground or the app):
- Vailmarch: wall water-gate + moat leat on the waterfront, market-pin plaza,
  nested Kingsmoot Green, the East Road forcing gates through the ring.
- Twinbridge + Eastwool: adjacent districts sharing a wall/edge (bit-matched
  stubs), different profiles.
- The Vail: gorge carve through the Marchspine, Strahler width steps below the
  two confluences; Torrent Beck reads the massif (mountain-torrent).
- Cairnwood: conifer stands + timberline over the Cairn Fells; Cairnfoot paddy
  terraces read the same contours; Hoarfell pasture slope-gates on Haward Horn.
- Riverine strips + water meadows on the Marn; hedgerows where Hollowbrake meets
  Merewood Common and the crofts.
