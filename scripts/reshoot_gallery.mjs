// One-off 025-E helper: re-capture the gallery screenshots after a stale-buffer
// flake (the documented screenshot-write infra class). Assumes the .mapcache is
// hot (the gate just wrote it) so the replay settles fast.
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";

const REVIEW = "/Users/athena/projects/campaign-map/review/gallery";
const CAMPAIGN = "preset-gallery";
const R = 7.6;
const SHOTS = [
  ["euro-medieval", -24], ["euro-continental", -8], ["na-grid", 8], ["na-suburb", 24],
  ["superblock", 40], ["tartan-grid", 56], ["ward-grid", 72], ["eixample", 88],
  ["haussmann", 104], ["baroque-axial", 120], ["canal-rings", 136], ["radial-star", 152],
  ["na-grid-seam", 168], ["euro-medieval-rings", 184],
];
const IDS = [
  "gallery-euro-medieval","gallery-euro-continental","gallery-na-grid","gallery-na-suburb",
  "gallery-superblock","gallery-tartan-grid","gallery-ward-grid","gallery-eixample",
  "gallery-haussmann","gallery-baroque-axial","gallery-canal-rings","gallery-radial-star",
  "gallery-na-grid-seam","gallery-euro-medieval-rings",
];

function ob(args) {
  return execFileSync("obsidian", ["vault=dev-vault", ...args], { encoding: "utf8", timeout: 30000, maxBuffer: 50*1024*1024, killSignal: "SIGKILL" }).trim();
}
function ev(code) { return ob(["eval", "code=" + code]); }
function vExpr() {
  return `app.workspace.getLeavesOfType('campaign-map-view').map(function(l){return l.view;}).find(function(v){return v&&v.campaign&&v.campaign.id==='${CAMPAIGN}'})`;
}
function front() {
  try { execFileSync("osascript", ["-e", 'tell application "Obsidian" to activate'], { timeout: 5000 }); } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) Open the gallery map.
ev("(function(){var m=document.querySelector('.modal-close-button');if(m)m.click();app.workspace.detachLeavesOfType('campaign-map-view');return 'reset';})()");
for (let i = 0; i < 8; i++) {
  const out = ob(["command", `id=campaign-map:open-map-${CAMPAIGN}`]);
  if (out.includes("Executed")) break;
  await sleep(1500);
}
for (let i = 0; i < 30; i++) { await sleep(1000); if (ev(`!!(${vExpr()})`).includes("true")) break; }

// 2) Wait until every district has features (hot cache => fast).
for (let i = 0; i < 120; i++) {
  await sleep(2000);
  const raw = ev(`(function(){var v=${vExpr()};if(!v)return 'no';return ${JSON.stringify(IDS)}.every(function(id){return (v.regionFeatureIds(id)||[]).length>0;});})()`);
  if (raw.includes("true")) break;
  if (i === 119) throw new Error("districts never settled");
}
console.log("all 14 districts settled");
// Close any stray modal (the stale-buffer frames showed a picker).
ev("(function(){var m=document.querySelector('.modal-close-button');if(m)m.click();return 'ok';})()");

// 3) Per-district shots: fitBounds, force repaint, activate, capture.
const sizes = new Map();
for (const [label, cx] of SHOTS) {
  ev(`(function(){var v=${vExpr()};v.map.fitBounds([[${cx - R},-${R}],[${cx + R},${R}]],{padding:40,animate:false});v.map.triggerRepaint();return 'ok';})()`);
  front();
  await sleep(2200);
  ob(["dev:screenshot", `path=${REVIEW}/${label}.png`]);
  const size = statSync(`${REVIEW}/${label}.png`).size;
  sizes.set(label, size);
  console.log(`shot ${label} (${size} bytes)`);
}
// Contact sheet.
ev(`(function(){var v=${vExpr()};v.map.fitBounds([[-33,-10],[193,10]],{padding:20,animate:false});v.map.triggerRepaint();return 'ok';})()`);
front();
await sleep(2500);
ob(["dev:screenshot", `path=${REVIEW}/_contact-sheet.png`]);
console.log(`shot _contact-sheet (${statSync(`${REVIEW}/_contact-sheet.png`).size} bytes)`);

// 4) Sanity: distinct presets should not all be byte-identical frames.
const uniq = new Set(sizes.values());
console.log(`unique sizes: ${uniq.size}/${sizes.size}`);
if (uniq.size < 5) throw new Error("screenshots look like repeated frozen frames — retry needed");
console.log("RESHOOT OK");
