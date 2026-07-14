---
map-campaign: true
crs: fictional
theme: obsidian-native
seed: 25025
scaleMetersPerUnit: 100
bounds:
  - -33
  - -10
  - 129
  - 10
---

Preset Gallery (plan 025 §3.5) — the living style catalog for city procgen.

One sketched district per city preset, all the SAME shape (regular 16-gon,
effective radius ~700 m ⇒ circumradius 7.091 units at
100 m/unit), laid in a 1×N row ON THE EQUATOR (lat 0) so Mercator treats
every district identically and on-screen differences are the PRESET, never the
boundary or projection:

    euro-medieval(-24)  euro-continental(-8)  na-grid(8)  na-suburb(24)  superblock(40)
    tartan-grid(56)  ward-grid(72)  eixample(88)  haussmann(104)  baroque-axial(120)

New presets APPEND to the right (fixed x, existing districts never move) and the
eastern bound widens to fit — so a fixture diff stays localised to the appended
district + the one bound. superblock landed in 025-B (§2.6); tartan-grid,
ward-grid and eixample landed in 025-C (§2.2–2.4 + the §3.4 chamfer operator);
haussmann and baroque-axial landed in 025-D (§2.1 + §2.5, the §3.2 axial-
breakthrough operator — boulevards cut through the fabric; bound 97→129).

Committed fixture: this note + Fabric.geojson are durable repo content; the
.mapcache/ is regenerable and sync-excluded. `scripts/gates/presetGallery.ts`
regenerates the gallery, screenshots each preset + a contact sheet into
review/gallery/, and prints the §3.1 metrics table vs the §1.2 Salat anchors.
New presets (025 phases B–E) append a district here with a before/after sheet.
