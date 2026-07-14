#!/usr/bin/env tsx
// VO wave-1 gate — plan 027-A/-B: PARK figure-ground + REAL skeletons.
//
// 027-B extends this gate (checks c2–c5 + formal/wild screenshots): per-variety
// skeletons hung off boundary ENTRANCES (sketched-road crossings + hashed
// fallbacks) — city-park perimeter loop + entrance diagonals + bandstand;
// formal-garden principal-axis composition + central basin + fountain + mirror
// beds; japanese circuit + roji spur + lanterns + teahouse; wild-common
// restraint (few paths, one landmark, open meadow). Point dressing is a NEW
// `park-point` gid — the checks that read pointKinds (bandstand/fountain/
// lantern/teahouse) PASS only once the orchestrator adds `park-point` to
// PARK_TILE_GENERATOR_IDS (uncached gids are dropped); that registry line is
// the documented integration step.
//
// Live against dev-vault via the obsidian CLI. Reshapes the shipped v4.7 park
// (procgen46) without touching the skeleton (that is 27-B): the ground is now
// ONE merged lawn polygon (no per-cell lattice → no hairline grid), a darker
// CANOPY second green sits over it (figure-ground — the #1 legibility fix),
// paths are re-emitted as classed LINESTRINGS rendered as cased lines (casing
// under fill), and the pond gains a shore-casing rim. The headless twin
// (createRegionForTest, kind=park — modals hang CLI) runs the FULL commit path,
// so this gate exercises exactly what confirming a park sketch does.
//
//   (a) city-park → figure-ground in cache + rendered: exactly ONE merged
//       park-lawn polygon, park-canopy clumps present (second green), paths are
//       park-path LineStrings; containment holds; determinism (regenerate twice
//       → byte-identical);
//   (b) PAINT probe: the live style carries generated-park-canopy,
//       generated-park-path-casing (a LINE, indexed UNDER the park-path fill
//       line), and generated-park-pond-shore (a LINE, ABOVE the pond fill);
//   (c) japanese-garden still emits the full composition set (pond/island/
//       bridge/rock/court) on a large region and stays contained;
//   (d) vertex edit adapts the tree scatter far LESS than a re-roll (locality
//       now measured on park-tree, since the lawn = the seed-independent ring),
//       both stay contained;
//   (e) rerollRegion → NEW seed, tree scatter changes, still contained;
//   (f) sketch-edit undo restores the previous park;
//   (g) pan/zoom → generatorRunCount unchanged (explicit-only preserved);
//   (h) dev:errors clean end-to-end;
//   screenshots → review/: a city-park at a CLOSE zoom (two-green + cased
//       paths legible) and at the z4.5 OVERVIEW (no lattice, no clutter, no
//       voids), plus a japanese-garden (asymmetric pond + island + bridge).
//   Visual bar (plan 027 §6): no lattice anywhere; lawn vs canopy read as two
//       greens; paths read as cased ribbons, not hairline scratches; pond
//       shoreline crisp; z4.5 overview clean.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Gate, obsidian, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

const CAMPAIGN = "vespergate";
const FOLDER = "dev-vault/Campaigns/Vespergate";
const CACHE_ABS = `${FOLDER}/.mapcache/generated.jsonl`;
const FABRIC_ABS = `${FOLDER}/Fabric.geojson`;
const REVIEW = "/Users/athena/projects/campaign-map/review";
const TEST_NAME = "__vo27_test__";
// Display units (1 unit = 50 m). Both parks sit well inside bounds
// [-48,-36,48,36] and clear of the migrated Vespergate district (~[-4.8, 6]).
// The rings are 20×20 units = 1000 m squares ⇒ maxInteriorDistance ~500 m, past
// the court(≥200 m)/island(≥130 m) rungs so the japanese composition emits.
const CITY_RING = "[[16,8],[36,8],[36,28],[16,28]]";
const JAPANESE_RING = "[[-40,-28],[-20,-28],[-20,-8],[-40,-8]]";
const CITY = "{ variety: 'city-park', pathDensity: 0.5, pond: true }";
const JAPANESE = "{ variety: 'japanese-garden', pathDensity: 0.4, pond: true }";
// The japanese composition set — every one must render on a large region.
const COMPOSITION: readonly string[] = ["park-pond", "park-island", "park-bridge", "park-rock", "park-court"];
// The paint layers plan 027-A adds/changes — all must exist on the live style.
const NEW_PAINT_LAYERS: readonly string[] = [
  "generated-park-canopy",
  "generated-park-path-casing",
  "generated-park-pond-shore",
  "generated-park-point", // plan 027-B point dressing (fountain/bandstand/monument/lantern/teahouse)
];
// Plan 027-B rings. FORMAL is a wide rectangle (2:1) so the principal axis is
// unambiguously horizontal; WILD is a modest square (restraint reads at any size).
const FORMAL_RING = "[[8,-28],[44,-28],[44,-10],[8,-10]]";
const WILD_RING = "[[-40,10],[-24,10],[-24,26],[-40,26]]";
const FORMAL = "{ variety: 'formal-garden', pathDensity: 0.5, pond: false }";
const WILD = "{ variety: 'wild-common', pathDensity: 0.3, pond: false }";

function viewExpr(): string {
  return `app.workspace.getLeavesOfType('campaign-map-view').map(function(l){return l.view;}).find(function(v){return v&&v.campaign&&v.campaign.id==='${CAMPAIGN}'})`;
}
function resetLeaves(): void {
  evalJs("app.workspace.detachLeavesOfType('campaign-map-view'); 'reset'");
}
async function issueOpen(): Promise<void> {
  resetLeaves();
  for (let i = 0; i < 8; i++) {
    const out = obsidian(`command id=campaign-map:open-map-${CAMPAIGN}`);
    if (String(out).includes("Executed")) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
}
async function waitFor(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error(`timed out waiting for ${what}`);
}
/** Runs an async MapView method in-app, parking the result on window.__vo27. */
async function evalAsync(body: string, timeoutMs = 180000): Promise<unknown> {
  evalJs(`window.__vo27 = undefined; (function(){
    var v = ${viewExpr()};
    if (!v) { window.__vo27 = { error: 'no view' }; return 'no-view'; }
    (${body})(v).then(function(r){ window.__vo27 = { ok: r }; }, function(e){ window.__vo27 = { error: String(e && e.message || e) }; });
    return 'started';
  })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = evalJs("JSON.stringify(window.__vo27 === undefined ? null : window.__vo27)");
    const parsed = typeof out === "string" ? JSON.parse(out) : out;
    if (parsed !== null) {
      if (parsed.error) throw new Error(`in-app async failed: ${parsed.error}`);
      return parsed.ok;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error("in-app async timed out");
}
function sync(expr: string): unknown {
  return evalJs(`(function(){ var v=${viewExpr()}; return (${expr}); })()`);
}
/** Front Obsidian (App Nap stalls MapLibre's style load in an occluded window). */
function front(): void {
  try {
    execFileSync("osascript", ["-e", 'tell application "Obsidian" to activate'], { timeout: 5000 });
  } catch {
    /* best-effort */
  }
}
/** park-tree coordinate buckets (gen-space meters) — since 027-A the lawn is
 * the (seed-independent) ring itself, so edit-locality is carried by the
 * seed-driven scatter-tree grid. A fine grid so re-jittered trees register. */
function treeBuckets(id: string, grid = 10): string[] {
  const code = `(function(){var v=${viewExpr()};var pre='region:'+${JSON.stringify(id)}+':';var s=new Set();v.loadedTiles.forEach(function(feats,k){if(k.indexOf(pre)!==0)return;feats.forEach(function(f){if(!f.properties||f.properties.generatorId!=='park-tree')return;var g=f.geometry;if(!g||!g.coordinates)return;var scan=function(c){if(!Array.isArray(c))return;if(typeof c[0]==='number'&&typeof c[1]==='number'){s.add(Math.round(c[0]/${grid})+','+Math.round(c[1]/${grid}));return;}c.forEach(scan);};scan(g.coordinates);});});return JSON.stringify(Array.from(s));})()`;
  const r = evalJs(code);
  return (typeof r === "string" ? JSON.parse(r) : r) as string[];
}
function overlapPct(a: string[], b: string[]): number {
  if (a.length === 0) return 0;
  const sa = new Set(a);
  return (b.filter((x) => sa.has(x)).length / a.length) * 100;
}
function containment(id: string): { count: number; outside: number } {
  return sync(`JSON.stringify(v.regionContainmentReport(${JSON.stringify(id)}))`) as { count: number; outside: number };
}
function featureCount(id: string, gid: string): number {
  // DISTINCT feature ids, not raw record count: the cache stores per-tile
  // clipped records, so one logical feature spanning N tiles yields N records
  // sharing one id (same per-tile-clip semantics documented for procgen46,
  // DECISIONS 2026-07-13 phase D). "ONE merged lawn" means one identity.
  return sync(`new Set(v.regionFeatureIds(${JSON.stringify(id)}, ${JSON.stringify(gid)})).size`) as number;
}
/** Distinct `class` values across a region's park-path LineStrings (plan 027-B
 * skeleton: axis/loop/circuit/walk/roji). */
function pathClasses(id: string): string[] {
  const code = `(function(){var pre='region:'+${JSON.stringify(id)}+':';var s=new Set();v.loadedTiles.forEach(function(feats,k){if(k.indexOf(pre)!==0)return;feats.forEach(function(f){if(f.properties&&f.properties.generatorId==='park-path'&&f.properties.class)s.add(f.properties.class);});});return JSON.stringify(Array.from(s));})()`;
  const r = sync(code);
  return (typeof r === "string" ? JSON.parse(r) : r) as string[];
}
/** Distinct `pointKind` values across a region's park-point features (plan
 * 027-B: fountain/bandstand/monument/lantern/teahouse). Empty until the
 * orchestrator adds `park-point` to PARK_TILE_GENERATOR_IDS (uncached gids are
 * dropped) — that registry line is the integration step this gate verifies. */
function pointKinds(id: string): string[] {
  const code = `(function(){var pre='region:'+${JSON.stringify(id)}+':';var s=new Set();v.loadedTiles.forEach(function(feats,k){if(k.indexOf(pre)!==0)return;feats.forEach(function(f){if(f.properties&&f.properties.generatorId==='park-point'&&f.properties.pointKind)s.add(f.properties.pointKind);});});return JSON.stringify(Array.from(s));})()`;
  const r = sync(code);
  return (typeof r === "string" ? JSON.parse(r) : r) as string[];
}
/** Is a region's perimeter loop a CLOSED circuit? The cache stores PER-TILE
 * clipped segments (one closed loop spanning N tiles = N open polylines), so
 * "closed" cannot be read off any single record. A closed circuit clipped into
 * segments has NO odd-degree endpoint: every mm-quantized polyline endpoint
 * (incl. tile-edge cut points, present in both neighbours) pairs up. An open
 * path would leave 2 degree-1 endpoints. Same per-tile-clip semantics as the
 * distinct-id counting above (DECISIONS 2026-07-13 phase D). */
function hasClosedLoop(id: string): boolean {
  const code = `(function(){var pre='region:'+${JSON.stringify(id)}+':';var deg={};var n=0;v.loadedTiles.forEach(function(feats,k){if(k.indexOf(pre)!==0)return;feats.forEach(function(f){if(!f.properties||f.properties.generatorId!=='park-path'||f.properties.class!=='loop')return;var c=f.geometry&&f.geometry.coordinates;if(!c||c.length<2)return;n++;[c[0],c[c.length-1]].forEach(function(p){var key=(Math.round(p[0]*1000))+','+(Math.round(p[1]*1000));deg[key]=(deg[key]||0)+1;});});});if(n===0)return false;var odd=0;for(var k2 in deg){if(deg[k2]%2===1)odd++;}return odd===0;})()`;
  return sync(code) as boolean;
}
/** Live style layers under the generated- park stack: {id, type} in paint order. */
function parkStyleLayers(): { id: string; type: string }[] {
  const code = `JSON.stringify((v.map.getStyle().layers||[]).filter(function(l){return l.id.indexOf('generated-park')===0;}).map(function(l){return {id:l.id,type:l.type};}))`;
  const r = sync(code);
  return (typeof r === "string" ? JSON.parse(r) : r) as { id: string; type: string }[];
}
function regionCacheRecords(regionId: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(CACHE_ABS)) return out;
  const prefix = `region:${regionId}:`;
  for (const line of readFileSync(CACHE_ABS, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as { key: string; features: unknown };
    if (rec.key.startsWith(prefix)) out.set(rec.key, JSON.stringify(rec.features));
  }
  return out;
}
function fabricFeature(id: string): { id: string; properties: { procgen?: { seed?: number } } } | undefined {
  const fabric = JSON.parse(readFileSync(FABRIC_ABS, "utf8")) as {
    features: { id: string; properties: { procgen?: { seed?: number } } }[];
  };
  return fabric.features.find((f) => f.id === id);
}
function stripTestFabric(): void {
  if (!existsSync(FABRIC_ABS)) return;
  const fabric = JSON.parse(readFileSync(FABRIC_ABS, "utf8")) as {
    features?: { id?: string; properties?: { name?: string } }[];
  };
  if (!Array.isArray(fabric.features)) return;
  const before = fabric.features.length;
  const removed = fabric.features.filter((f) => f.properties?.name === TEST_NAME).map((f) => f.id);
  fabric.features = fabric.features.filter((f) => f.properties?.name !== TEST_NAME);
  if (fabric.features.length !== before) {
    writeFileSync(FABRIC_ABS, JSON.stringify(fabric, null, 2));
    if (existsSync(CACHE_ABS)) {
      const kept = readFileSync(CACHE_ABS, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .filter((l) => {
          try {
            const r = JSON.parse(l) as { key: string };
            return !removed.some((id) => id && r.key.startsWith(`region:${id}:`));
          } catch {
            return true;
          }
        });
      writeFileSync(CACHE_ABS, kept.join("\n") + "\n");
    }
  }
}
async function newPark(ring: string, params: string): Promise<string> {
  const res = (await evalAsync(
    `function(v){ return v.createRegionForTest(${ring}, 'park', ${params}, '${TEST_NAME}', 'park'); }`
  )) as { featureId: string; count: number; outside: number };
  if (res.count < 1) throw new Error("no park features generated");
  if (res.outside > 0) throw new Error(`${res.outside} coords outside the ring at creation`);
  return res.featureId;
}

async function main(): Promise<void> {
  const gate = new Gate();
  console.log("== VO wave-1 gate (plan 027-A: park figure-ground + path rendering) ==\n");

  await gate.try("unit gates: park gen + fuzz + region + generated paint + style validity + controller lifecycle", () => {
    execFileSync(
      "npx",
      [
        "vitest",
        "run",
        "src/gen/park.test.ts",
        "src/gen/region.test.ts",
        "src/gen/procgen",
        "src/map/themes/generatedLayers.test.ts",
        "src/map/styleValidation.test.ts",
        "src/controller/MapController.test.ts",
      ],
      { encoding: "utf8", stdio: "pipe", timeout: 300_000 }
    );
    execFileSync("npx", ["vitest", "run", "--config", "vitest.fuzz.config.ts", "src/gen/park.fuzz.test.ts"], {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 300_000,
    });
  });

  await gate.try("plugin loads (reloaded), no errors, cache clean", () => {
    stripTestFabric();
    if (existsSync(CACHE_ABS)) rmSync(CACHE_ABS);
    obsidian("plugin:reload id=campaign-map");
    clearErrors();
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("vespergate opens (migration + replay settle)", async () => {
    await issueOpen();
    front();
    await waitFor(() => evalJs(`!!(${viewExpr()})`) === true, 20000, "vespergate view");
    await new Promise((r) => setTimeout(r, 3500));
  });

  let id = "";
  await gate.try("(a) city-park → figure-ground: ONE merged lawn + canopy + LineString paths, contained + deterministic", async () => {
    id = await newPark(CITY_RING, CITY);
    const lawn = featureCount(id, "park-lawn");
    const canopy = featureCount(id, "park-canopy");
    const path = featureCount(id, "park-path");
    if (lawn !== 1) throw new Error(`expected exactly ONE merged park-lawn polygon, got ${lawn}`);
    if (canopy < 1) throw new Error("no park-canopy clumps (the second green) rendered");
    if (path < 1) throw new Error("no park-path features rendered");
    // Paths must be LineStrings now (cased-line rendering hook), not span quads.
    const pathGeom = sync(
      `(function(){var pre='region:'+${JSON.stringify(id)}+':';var t=null;v.loadedTiles.forEach(function(feats,k){if(k.indexOf(pre)!==0)return;feats.forEach(function(f){if(f.properties&&f.properties.generatorId==='park-path'&&!t)t=f.geometry.type;});});return t;})()`
    );
    if (pathGeom !== "LineString") throw new Error(`park-path geometry is ${pathGeom}, expected LineString`);
    const cont = containment(id);
    if (cont.outside > 0) throw new Error(`${cont.outside} coords outside the ring`);
    const recs = regionCacheRecords(id);
    if (recs.size === 0) throw new Error("no region cache records for the park");
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(id)}); }`);
    const r1 = regionCacheRecords(id);
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(id)}); }`);
    const r2 = regionCacheRecords(id);
    for (const [k, feats] of r1) {
      if (r2.get(k) !== feats) throw new Error(`record ${k} not byte-identical across regenerate — determinism broke`);
    }
    console.log(`     [a] lawn ${lawn} (merged), canopy ${canopy}, path ${path} (LineString); ${r1.size} records byte-identical twice`);
  });

  await gate.try("(b) PAINT probe: canopy + cased path + shore casing present, casing UNDER fill, shore ABOVE pond", () => {
    const layers = parkStyleLayers();
    const ids = layers.map((l) => l.id);
    for (const need of NEW_PAINT_LAYERS) {
      if (!ids.includes(need)) throw new Error(`live style missing ${need}`);
    }
    const byId = (want: string): { id: string; type: string } => {
      const l = layers.find((x) => x.id === want);
      if (!l) throw new Error(`live style missing ${want}`);
      return l;
    };
    if (byId("generated-park-path").type !== "line") throw new Error("park-path fill is not a line layer");
    if (byId("generated-park-path-casing").type !== "line") throw new Error("park-path-casing is not a line layer");
    if (byId("generated-park-pond-shore").type !== "line") throw new Error("park-pond-shore is not a line layer");
    const idx = (want: string): number => ids.indexOf(want);
    if (!(idx("generated-park-path-casing") < idx("generated-park-path"))) {
      throw new Error("path casing must paint UNDER the path fill line");
    }
    if (!(idx("generated-park-pond-shore") > idx("generated-park-pond"))) {
      throw new Error("pond shore casing must paint ABOVE the pond fill (a rim)");
    }
    if (!(idx("generated-park-canopy") > idx("generated-park-lawn"))) {
      throw new Error("canopy (second green) must paint ABOVE the lawn");
    }
    console.log(`     [b] ${layers.length} generated-park layers; canopy>lawn, casing<fill, shore>pond all hold`);
  });

  let japId = "";
  await gate.try("(c) japanese-garden → full composition set still emits on a large region, contained", async () => {
    japId = await newPark(JAPANESE_RING, JAPANESE);
    if (featureCount(japId, "park-lawn") !== 1) throw new Error("japanese-garden lawn is not a single merged polygon");
    const counts: Record<string, number> = {};
    for (const gid of COMPOSITION) {
      const n = featureCount(japId, gid);
      counts[gid] = n;
      if (n < 1) throw new Error(`japanese-garden emitted no ${gid} on a large region`);
    }
    if (containment(japId).outside > 0) throw new Error("japanese-garden coords outside the ring");
    console.log(`     [c] ${COMPOSITION.map((g) => `${g.replace("park-", "")}:${counts[g]}`).join(" ")}`);
  });

  await gate.try("(c2) city-park 027-B skeleton: perimeter loop (closed) + entrance-connected walks + bandstand", () => {
    const classes = pathClasses(id);
    if (!classes.includes("loop")) throw new Error(`city-park has no perimeter loop path (classes: ${classes.join(",")})`);
    if (!classes.includes("walk")) throw new Error(`city-park has no entrance diagonals (classes: ${classes.join(",")})`);
    if (!hasClosedLoop(id)) throw new Error("city-park perimeter loop is not a closed ring");
    const kinds = pointKinds(id);
    // park-point is cached only after the orchestrator adds it to the registry.
    if (!kinds.includes("bandstand")) throw new Error(`city-park missing the bandstand park-point (kinds: ${kinds.join(",")}) — registry line for park-point landed?`);
    console.log(`     [c2] path classes {${classes.join(",")}}, closed loop, point kinds {${kinds.join(",")}}`);
  });

  let formalId = "";
  await gate.try("(c3) formal-garden 027-B: axial paths + central basin + fountain + ≥4 mirror beds, contained", async () => {
    formalId = await newPark(FORMAL_RING, FORMAL);
    const classes = pathClasses(formalId);
    if (!classes.includes("axis")) throw new Error(`formal-garden has no axis paths (classes: ${classes.join(",")})`);
    if (featureCount(formalId, "park-pond") !== 1) throw new Error("formal-garden has no central basin (park-pond)");
    const beds = featureCount(formalId, "park-bed");
    if (beds < 4) throw new Error(`formal-garden emitted ${beds} beds, expected ≥4 mirror compartments`);
    const kinds = pointKinds(formalId);
    if (!kinds.includes("fountain")) throw new Error(`formal-garden missing the basin fountain park-point (kinds: ${kinds.join(",")})`);
    if (containment(formalId).outside > 0) throw new Error("formal-garden coords outside the ring");
    console.log(`     [c3] axis paths, basin+fountain, ${beds} beds, contained`);
  });

  await gate.try("(c4) japanese 027-B: circuit + roji spur + lanterns + teahouse (odd-count rocks)", () => {
    const classes = pathClasses(japId);
    if (!classes.includes("circuit")) throw new Error(`japanese-garden has no circuit path (classes: ${classes.join(",")})`);
    if (!classes.includes("roji")) throw new Error(`japanese-garden has no roji spur (classes: ${classes.join(",")})`);
    const kinds = pointKinds(japId);
    if (!kinds.includes("lantern")) throw new Error(`japanese-garden missing lanterns (kinds: ${kinds.join(",")}) — park-point registry line landed?`);
    if (!kinds.includes("teahouse")) throw new Error(`japanese-garden missing the teahouse (kinds: ${kinds.join(",")})`);
    console.log(`     [c4] path classes {${classes.join(",")}}, point kinds {${kinds.join(",")}}`);
  });

  let wildId = "";
  await gate.try("(c5) wild-common 027-B restraint: ≤4 paths, ONE landmark, no manicured canopy, contained", async () => {
    wildId = await newPark(WILD_RING, WILD);
    const path = featureCount(wildId, "park-path");
    if (path > 4) throw new Error(`wild-common emitted ${path} paths — not restrained (expected ≤4 desire-line runs)`);
    const point = featureCount(wildId, "park-point");
    if (point !== 1) throw new Error(`wild-common emitted ${point} landmarks, expected exactly ONE (monument/maypole)`);
    if (featureCount(wildId, "park-canopy") !== 0) throw new Error("wild-common should have no manicured canopy masses");
    if (containment(wildId).outside > 0) throw new Error("wild-common coords outside the ring");
    console.log(`     [c5] paths ${path}, landmarks ${point}, no canopy, contained`);
  });

  await gate.try("(d) vertex edit adapts the tree scatter far less than a re-roll (locality) + stays contained", async () => {
    const base = treeBuckets(id);
    if (base.length === 0) throw new Error("no park-tree buckets — cannot measure locality");
    // Move a corner (open-index 1 = [36,8]) outward — only trees near it change
    // containment, so the scatter overlap stays high.
    const ok = await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 1, [40, 8]); }`);
    if (ok !== true) throw new Error("moveVertex returned false (reverted)");
    const editOverlap = overlapPct(base, treeBuckets(id));
    if (containment(id).outside > 0) throw new Error("coords outside after vertex edit");
    // Reset the corner, snapshot, then re-roll → the whole tree scatter re-places.
    await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 1, [36, 8]); }`);
    const pre = treeBuckets(id);
    await evalAsync(`function(v){ return v.rerollRegion(${JSON.stringify(id)}); }`);
    const rerollOverlap = overlapPct(pre, treeBuckets(id));
    console.log(`     [d] edit overlap ${editOverlap.toFixed(1)}% | re-roll overlap ${rerollOverlap.toFixed(1)}%`);
    if (!(editOverlap > rerollOverlap + 15)) {
      throw new Error(`edit (${editOverlap.toFixed(1)}%) did not stay more stable than re-roll (${rerollOverlap.toFixed(1)}%)`);
    }
    if (!(editOverlap > 70)) throw new Error(`edit overlap unexpectedly low (${editOverlap.toFixed(1)}%)`);
  });

  await gate.try("(e) re-roll → new seed, tree scatter changes, still contained", async () => {
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, ${CITY}); }`);
    const seedBefore = fabricFeature(id)?.properties.procgen?.seed;
    const pre = treeBuckets(id);
    await evalAsync(`function(v){ return v.rerollRegion(${JSON.stringify(id)}); }`);
    const seedAfter = fabricFeature(id)?.properties.procgen?.seed;
    const overlap = overlapPct(pre, treeBuckets(id));
    console.log(`     [e] seed ${seedBefore} → ${seedAfter}; re-roll overlap ${overlap.toFixed(1)}%`);
    if (seedBefore === seedAfter) throw new Error("re-roll did not change the persisted seed");
    if (overlap > 92) throw new Error("re-roll did not visibly change the park tree scatter");
    if (containment(id).outside > 0) throw new Error("coords outside after re-roll");
    if (featureCount(id, "park-lawn") !== 1) throw new Error("re-rolled park lawn is not a single merged polygon");
  });

  await gate.try("(f) sketch-edit undo restores the previous park", async () => {
    const pre = treeBuckets(id);
    // Move the corner INWARD so trees are REMOVED (an outward extension only adds
    // trees, leaving every pre bucket present — overlap wouldn't drop).
    await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 1, [26, 12]); }`);
    const edited = treeBuckets(id);
    if (overlapPct(pre, edited) > 98) throw new Error("edit didn't change the park — can't test undo");
    await evalAsync(`function(v){ return v.undoLastEdit(); }`);
    const back = overlapPct(pre, treeBuckets(id));
    console.log(`     [f] restored-vs-pre-edit overlap ${back.toFixed(1)}%`);
    if (back < 98) throw new Error(`undo did not restore the pre-edit park (${back.toFixed(1)}%)`);
    if (containment(id).outside > 0) throw new Error("coords outside after undo");
  });

  await gate.try("(g) pan/zoom never generates (explicit-only preserved)", async () => {
    await new Promise((r) => setTimeout(r, 1200));
    const before = sync("v.generatorRunCount") as number;
    sync(
      "(function(){v.map.jumpTo({center:[26,18],zoom:5});v.map.jumpTo({center:[-30,-18],zoom:11});v.map.jumpTo({center:[26,18],zoom:9});return 'ok';})()"
    );
    await new Promise((r) => setTimeout(r, 1500));
    const after = sync("v.generatorRunCount") as number;
    if (before !== after) throw new Error(`generatorRunCount moved under pan/zoom: ${before} -> ${after}`);
  });

  await gate.try("screenshot: city-park CLOSE (two-green figure-ground + cased paths legible)", async () => {
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, ${CITY}); }`);
    if (containment(id).outside > 0) throw new Error("city-park spilled outside its ring");
    sync("(function(){v.map.fitBounds([[14,6],[38,30]],{animate:false,padding:40});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/vo27-park-city-close.png`);
  });

  await gate.try("screenshot: city-park OVERVIEW z4.5 (no lattice, no clutter, no voids)", async () => {
    sync("(function(){v.map.jumpTo({center:[26,18],zoom:4.5});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2000));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/vo27-park-city-overview.png`);
  });

  await gate.try("screenshot: japanese-garden (asymmetric, pond + island + bridge)", async () => {
    if (containment(japId).outside > 0) throw new Error("japanese-garden spilled outside its ring");
    sync("(function(){v.map.fitBounds([[-42,-30],[-18,-6]],{animate:false,padding:40});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/vo27-park-japanese.png`);
  });

  await gate.try("screenshot: formal-garden (bilateral axis composition + central basin + mirror beds)", async () => {
    if (containment(formalId).outside > 0) throw new Error("formal-garden spilled outside its ring");
    sync("(function(){v.map.fitBounds([[6,-30],[46,-8]],{animate:false,padding:40});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/vo27-park-formal.png`);
  });

  await gate.try("screenshot: wild-common (restraint — meadow + a desire line + a duck pond + ONE landmark)", async () => {
    if (containment(wildId).outside > 0) throw new Error("wild-common spilled outside its ring");
    sync("(function(){v.map.fitBounds([[-42,8],[-22,28]],{animate:false,padding:40});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/vo27-park-wild.png`);
  });

  await gate.try("(h) dev:errors clean at end", () => {
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  // Self-clean: strip every gate fixture (app closed → no in-memory/disk race).
  resetLeaves();
  await new Promise((r) => setTimeout(r, 800));
  stripTestFabric();

  process.exit(gate.summarize("VO wave-1 park (plan 027-A)"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
