---
map-campaign: true
crs: fictional
theme: modern-clean
seed: 20931
scaleMetersPerUnit: 500
bounds: [-9.2, -9.2, 9.2, 9.2]
terrain:
  campAmp: 140
  seaDatum: 0
---

# The Cradle — Island One

A high-fidelity recreation of THE CRADLE (Island One), the player map from the
TTRPG *Deathmatch Island*: one large irregular island in an open sea, a
point-crawl of 14 numbered locations wired by 20 trails. Two safe LANDINGS
(the Industrial Port on the east bulge, the Fishing Village on the SE
peninsula), a walled COMPOUND and a STADIUM in the northern uplands, a
SANCTUARY at the heart, and a lone LIGHTHOUSE on its own rock off the SW tip.

Terrain is GLOBAL: a sea plate at the datum, the island a low ~30 m plateau
bounded by an organic coast ring on top of it (higher priority ⇒ it wins inside
the shore), the islet a smaller plateau, and six highland RELIEF ridge stamps
(the tall North Heights, the Portside and central Spine ridges, the SW
Ridgeback, the West Hills, and House Hill) lifting the local relief. There are
NO rivers. Built-up fabric — the two landings, the Apartment Blocks, and the
Compound — is city procgen driven by the sketched district rings; the dead-wood
Scrublands fill the wild north-centre.

Every feature is generated from `scripts/emit-cradle-campaign.ts`; regenerate
this directory with `npx tsx scripts/emit-cradle-campaign.ts` (never hand-edit
— edits are overwritten). 1 map unit = 500 m, so the island is ~7 × 6 km.
