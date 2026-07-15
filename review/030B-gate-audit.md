# 030-B gate audit — every live gate, its unique coverage, and its fate

*Working document for the plan 030-B shrink. Fate is executed only after the
"prove-by-breaking" column shows the replacement catching a seeded failure.*

## The smoke set (what remains — 5 gates)

| smoke gate | absorbs | uniquely live coverage |
|---|---|---|
| `smokeBoot.ts` | phase0, styleLoad, phase2 (theme/style half), hillshade23d (style half) | plugin loads in Obsidian, map view opens, style builds per theme incl. obsidian-native css-derivation, PMTiles basemap source resolves (real CRS), raster-dem source + campaigndem protocol present, dev:errors clean |
| `smokeReconcile.ts` | phase1 | note create → pin appears; rename → label follows; delete → pin gone; invalid frontmatter → warning badge not silent drop; connections resolve |
| `smokeProcgen.ts` | procgen40, phase3 (replay), phase4 (explicit-only) | sketch→region→generate→paint in the LIVE renderer; reopen replays from cache with zero generator runs; pan/zoom storm leaves generatorRunCount flat; Vespergate byte-intact |
| `smokeAdoption.ts` | version29, procgen40 (migration half) | disc-domain migration; pinned-old consent lifecycle (prompt/decline/badge/adopt) live |
| `smokeExports.ts` | phase5 | poster PNG + atlas PDF actually write files; replay/populate/import command surfaces run without renderer errors |

## Gates to delete after their replacement catches a seeded break

| gate | unique coverage today | replacement (headless) | seeded break to prove |
|---|---|---|---|
| procgen41 | edit UX lifecycle (vertex/params/reroll/center/undo) | MapController.test.ts procgen41 family | disable vertex-edit regen → controller test fails |
| procgen42 | city content (faces/parcels/wards/one-network-compute) | citynet suites + metrics bands + cityGolden | drop parcel emission → band/golden fails |
| procgen43 | profile signatures flip | cityGolden + profile band tests | swap two profile tables → signature test fails |
| procgen44 | river spine containment + presets | river suite + invariants + bands + perceptual | widen channel beyond corridor → invariants fail |
| procgen45 | forest canopy + containment | forest suite + invariants + bands + perceptual | break clearing holes → band fails |
| procgen46 | park varieties + containment | park suite + invariants + bands + perceptual | drop path web → band fails |
| procgen47 | wall towers/gates/moat | wall suite + invariants + bands + perceptual | stop emitting towers → band fails |
| procgen48 | farmland fields/lanes + outskirt suppression | farmland suite + invariants + bands | drop lane emission → band fails |
| procgen49 | river visual overhaul (ribbon/banks/islands) | river suite + bands + perceptual golden | remove bank casings → perceptual diff fails |
| procgen49-forest | clumped trees paint | forest bands + perceptual | tree count change → band/perceptual fails |
| procgen50-canopy | organic canopy + holes | forest suite (MultiPolygon holes) + perceptual | fill holes → suite/perceptual fails |
| procgen51-glyphs | SDF glyph registration + setStyle survival | treeGlyphs pixel-hash unit tests; glyph lifecycle folds into smokeBoot | corrupt SDF encode → pixel-hash fails |
| fields23a | bit-exact fields retrofit | fields unit suites (already the proof) | perturb interiorT → unit fails |
| elevation23b | mountain relief emission | mountain suite + bands | drop hachures → band fails |
| contours23c | contour iso-lines | mountain suite (contour counts in bands) | disable contour tracing → band fails |
| hillshade23d | DEM lattice determinism (unit half) + style (smokeBoot half) | demCache tests + smokeBoot raster-dem check | corrupt height quantization → dem test fails |
| coupling23e | paddy terraces + river-slope coupling | farmland/river suites + cascade controller tests | zero slopeSensitivity effect → coupling test fails |
| staleness24a | fingerprint staleness on external edit | fingerprint tests + MapController staleness tests | skip fingerprint compare → test fails |
| cascade24b | stage-DAG cascade on upstream edit | MapController cascade family | break stage ordering → cascade test fails |
| cascade24c | city consumes river channel | upstreamConsume.test.ts (citynet) | sever upstream.water → consume test fails |
| presetGallery | 12-preset visual catalog + byte-stability | perceptual goldens (euro-medieval + haussmann pinned; extend per-preset later) + cityGolden byte test | paint/geometry change → perceptual diff fails |
| phase2 (measurement half) | handcrafted theme paint values | styleValidation.test.ts + smokeBoot style checks | wrong token value → styleValidation fails |
| phase3 (generate half) | world-tier generate/clear | MapController world-tier tests | break world generate → controller test fails |
| phase4 (perf half) | frame-time sampler, rescan budget | KEEP the two perf probes → move into smokeBoot as advisory prints (never fail on Mac Neo — perf is Surface-Pro-budget territory) | n/a (advisory) |

## Rules honored
- A gate is deleted only in the same commit that records its seeded break +
  the replacement's failing output (prove-by-breaking, per gate).
- Any gate whose unique coverage cannot be reproduced headlessly STAYS —
  that's why boot/reconcile/live-paint/exports/adoption remain live.
- The flake-logging rule survives for the smoke set.
