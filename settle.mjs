import { execFileSync } from "node:child_process";
const CAMPAIGN="preset-gallery";
function ev(expr){try{return execFileSync("obsidian",["vault=dev-vault","eval","code="+expr],{encoding:"utf8",timeout:25000}).trim();}catch(e){return "ERR";}}
function vExpr(){return `app.workspace.getLeavesOfType('campaign-map-view').map(function(l){return l.view;}).find(function(v){return v&&v.campaign&&v.campaign.id==='${CAMPAIGN}'})`;}
ev("app.workspace.detachLeavesOfType('campaign-map-view')");
for(let i=0;i<8;i++){const o=execFileSync("obsidian",["vault=dev-vault","command","id=campaign-map:open-map-"+CAMPAIGN],{encoding:"utf8"});if(o.includes("Executed"))break;await new Promise(r=>setTimeout(r,1500));}
for(let i=0;i<20;i++){await new Promise(r=>setTimeout(r,1000));if(ev(`!!(${vExpr()})`).includes("true"))break;}
const ids=["gallery-euro-medieval","gallery-euro-continental","gallery-na-grid","gallery-na-suburb","gallery-superblock","gallery-tartan-grid","gallery-ward-grid","gallery-eixample","gallery-haussmann","gallery-baroque-axial","gallery-canal-rings","gallery-radial-star","gallery-na-grid-seam","gallery-euro-medieval-rings"];
const t0=Date.now();
for(let poll=0;poll<90;poll++){
  await new Promise(r=>setTimeout(r,3000));
  const raw=ev(`(function(){var v=${vExpr()};if(!v)return 'NOVIEW';var p=v.controller?v.controller.pendingGenerationCount:-1;return p+'|'+${JSON.stringify(ids)}.map(function(id){return (v.regionFeatureIds(id)||[]).length;}).join(',');})()`);
  const [pend,rest]=raw.split("|");
  const counts=(rest||"").split(",").map(Number);
  const ready=counts.filter(c=>c>0).length;
  console.log(`t=${((Date.now()-t0)/1000).toFixed(0)}s pending=${pend} ready=${ready}/14`);
  if(ready===14){console.log("ALL 14 READY at",((Date.now()-t0)/1000).toFixed(0),"s");break;}
}
