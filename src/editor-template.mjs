import { readFileSync } from "node:fs";
import { wallStructure } from "./design-rules.mjs";
const base = new URL("../vendor/", import.meta.url);
const license = ["HOUSE-PLAN-DESIGNER-LICENSE", "THIRD_PARTY_LICENSES.txt"]
  .map((file) => readFileSync(new URL(file, base), "utf8"))
  .join("\n\n");
const structure = readFileSync(
  new URL("../public/editor-structure.js", import.meta.url),
  "utf8",
);
const encode = (value) => JSON.stringify(value).replaceAll("<", "\\u003c");
let template = readFileSync(new URL("designer.html", base), "utf8").replace(
  /<script id="__preset">.*?<\/script>/s,
  "",
);
// Each adaptation must match the pinned build exactly once. A changed upstream
// cannot silently disable desktop persistence, recovery or the editor bridge.
function adapt(original, replacement) {
  const first = template.indexOf(original);
  if (first < 0 || template.indexOf(original, first + original.length) >= 0)
    throw new Error("固定编辑器与桌面适配不匹配：" + original.slice(0, 50));
  template = template.replace(original, () => replacement);
}
adapt(
  'location.search.includes("debug")&&(window.__designer={',
  "true&&(window.__designer={importModel:cN,",
);
adapt("function JL(){", "function JL(){if(window.__HOUSEDIY__)return null;");
adapt("async function cN(t){", "async function cN(t,desktopId){");
adapt(
  "o={id:jt(),name:t.name.replace(/\\.(glb|gltf)$/i",
  "o={id:desktopId||jt(),name:t.name.replace(/\\.(glb|gltf)$/i",
);
adapt(
  'ih.set(o.id,n),await Qf("models",o),Go.set(o.id,o)',
  'await (window.houseModels?window.houseModels.put(o,{repair:desktopId===o.id}):Qf("models",o)),ih.set(o.id,n),Go.set(o.id,o)',
);
adapt(
  'await Fw("models")',
  'await (window.__SHARED__?[]:window.houseModels?window.houseModels.load(()=>Fw("models")):Fw("models"))',
);
adapt(
  'Go.set(t.id,t);try{await Qf("models",t)}catch{}_p()',
  'Go.set(t.id,t);if(!window.__SHARED__){try{await Qf("models",t)}catch{}}_p()',
);
adapt(
  'function i1(){return Qf("schemes"',
  'function i1(){if(window.__SHARED__)return Promise.resolve();return Qf("schemes"',
);
adapt(
  'await Uw("models",t),Go.delete(t),ih.delete(t),_p()',
  'await (window.houseModels?window.houseModels.remove(t):Uw("models",t));if(!window.houseModels||!k.plan.furniture.some(f=>f.modelId===t||f.key==="model:"+t)){Go.delete(t);ih.delete(t)}_p()',
);
adapt(
  "已放进方案的会变成占位方块。",
  '${window.houseModels?"已放进方案的模型仍会保留。":"已放进方案的会变成占位方块。"}',
);
adapt(
  "fN().then(()=>{ki(),To()})",
  "window.__houseModelsReady=Promise.all([fN(),window.houseShapes?.ready]).then(()=>{if(window.houseShapes)Hh();ki();To()})",
);
// A cached placeholder must be rebuilt when its GLB arrives in the catalog,
// so the renderer starts decoding even if the 3D scene was initialized first.
adapt(
  "n.modelId&&pN(n.modelId),Er.on",
  "n.modelId&&Go.has(n.modelId),n.modelId&&pN(n.modelId),Er.on",
);
adapt(
  "function Lh(){try",
  "function Lh(){if(window.houseShapes)return window.houseShapes.items();try",
);
adapt(
  "function z8(t){try",
  "async function z8(t){if(window.houseShapes)return window.houseShapes.save(t);try",
);
adapt("function pT(t,e){var o;", "async function pT(t,e){var o;");
adapt(
  '!z8(n)){Te("本机存储满了，没能存入造型库")',
  '!(await z8(n))){Hh();Te("未能保存造型，请重新打开方案后再试")',
);
adapt(
  "function EH(t){z8(Lh().filter(e=>e.id!==t)),Hh()}",
  'async function EH(t){if(!(await z8(Lh().filter(e=>e.id!==t))))Te("未能删除造型，请重新打开方案后再试");Hh()}',
);
adapt(
  "t.underlays&&cI(t.underlays),(i=t.fmLib)!=null&&i.length){const s=Lh(),o=new Set(s.map(r=>r.id)),a=t.fmLib.filter(r=>!o.has(r.id));a.length&&(z8([...s,...a]),Hh())}",
  "t.underlays&&cI(t.underlays);",
);
adapt(
  'if(t.from&&!e.name.includes("来自")&&',
  't.from&&!e.name.includes("来自")&&',
);
// The recipient opens a standalone file. Only the current shared plan, its
// source image and its referenced models belong in this copy of the editor.
adapt(
  '(e=t.querySelector("#__shared"))==null||e.remove(),sf=',
  't.querySelectorAll("#__shared,[data-housediy-desktop]").forEach(node=>node.remove()),sf=',
);
adapt(
  "const e=[...new Set(J.floors.flatMap(r=>r.plan.furniture).map(r=>r.modelId).filter(Boolean))].map(r=>aM(r)).filter(Boolean).map(",
  'const ids=[...new Set(J.floors.flatMap(f=>f.plan.furniture).map(f=>f.modelId||(f.key?.startsWith("model:")&&f.key.slice(6))).filter(Boolean))];if(ids.some(id=>!aM(id))){Te("请先补回方案引用的自定义模型，再生成分享文件");return}const e=ids.map(id=>aM(id)).map(',
);
adapt("function iW(){if(!sf)", "async function iW(){if(!sf)");
adapt(
  '}),n={plan:Ca(),from:v1()||"",time:Date.now(),models:e,underlays:lI(),fmLib:Lh()},i=JSON.stringify(n)',
  '});const underlays=lI().map((u,i)=>u?.src==="preset"?{...u,src:eh(i)?.src}:u);const contents=["当前方案和批注"];if(underlays.some(u=>u?.src))contents.push("描图底图");if(e.length)contents.push("自定义模型（"+e.map(r=>r.name).join("、")+"）");if(!await wo("导出离线分享文件","文件包含"+contents.join("、")+"。","导出"))return;const n={plan:Ca(),from:v1()||"",time:Date.now(),models:e,underlays},i=JSON.stringify(n)',
);
// Drawing tools can complete without WebGL animation frames. Cancel the old
// camera move and its timers before leaving the scene to prevent late updates.
adapt(
  "async function Aa(t){if(t===k.view||k.transitioning)return;",
  'let houseViewTimer,houseFitTimer;async function Aa(t,immediate=false){if(immediate&&t==="2d"){if(k.view===t&&!k.transitioning&&!ys)return;clearTimeout(houseViewTimer);clearTimeout(houseFitTimer);_o(!0);if(ys){ys=null;zt.enabled=!he.active}A2.dataset.view=t;k.view=t;k.transitioning=!1;document.querySelectorAll("#viewSeg button").forEach(n=>n.classList.toggle("on",n.dataset.view===t));Ni();return}if(t===k.view||k.transitioning)return;',
);
adapt(
  "k.view=t,setTimeout(()=>Yi(jo(),1400,()=>{k.transitioning=!1}),380)",
  "k.view=t,houseViewTimer=setTimeout(()=>Yi(jo(),1400,()=>{k.transitioning=!1}),380)",
);
adapt(
  "ct(),setTimeout(()=>{k.transitioning=!1},650)",
  "ct(),houseViewTimer=setTimeout(()=>{k.transitioning=!1},650)",
);
adapt(
  'k.view=t,setTimeout(()=>{k.transitioning=!1},700);t==="split"&&setTimeout(()=>Ni(),720)',
  'k.view=t,houseViewTimer=setTimeout(()=>{k.transitioning=!1},700);t==="split"&&(houseFitTimer=setTimeout(()=>Ni(),720))',
);
// Export labels use the drawn dimension lines as the reference and show the
// raster-derived room area as an estimate.
adapt(
  'f=o==="simple"?x3(r):null,u=t0(r),h=r.area.toFixed(2)+" ㎡"+(f?"  "+f:"")',
  'u=t0(r),h="约 "+r.area.toFixed(2)+" ㎡"',
);
adapt(
  'D.area.toFixed(2)+" ㎡"+(!o.noDims&&((V=k.opts.dims)==null?void 0:V.rooms)!==!1&&(c>.03||!u)&&x3(D)?`  ${x3(D)}`:"")',
  '(u?"":"约 ")+D.area.toFixed(2)+" ㎡"+(u&&!o.noDims&&((V=k.opts.dims)==null?void 0:V.rooms)!==!1&&c>.03&&x3(D)?`  ${x3(D)}`:"")',
);
adapt(
  "s(a,{x:180,y:60,w:fa-240,h:ha-120-l-20}),o",
  's(a,{x:180,y:60,w:fa-240,h:ha-120-l-20}),a.fillStyle="#5a6270",a.font=`500 25px ${vt}`,a.textAlign="left",a.textBaseline="middle",a.fillText("设计草稿 · 请现场复核尺寸",200,f+75),a.fillText("贴墙尺寸为净距，图外尺寸链含墙厚及分段尺寸。",200,f+115),o',
);
adapt("整套施工图（A3 PDF）", "设计图册（A3 PDF 草稿）");
adapt("-施工图.pdf", "-设计图册.pdf");
adapt("页 A3 施工图 PDF", "页 A3 设计图册");
adapt(" <b>${t.from}</b> ", " <b data-share-sender></b> ");
adapt(
  'n.style.display="flex",document.getElementById("sbX")',
  'n.querySelector("[data-share-sender]")?.append(document.createTextNode(String(t.from))),n.style.display="flex",document.getElementById("sbX")',
);
adapt(
  'w.bearing?"承重墙":"非承重墙"',
  'window.__wallStructureLabel?window.__wallStructureLabel(w):(w.bearing?"承重墙":"非承重墙")',
);
adapt(
  'if(t.bearing){Te("这是承重墙，不能拆除");return}',
  'if(window.__wallStructure?.(t)==="unknown"&&t.status!=="removed"){Te("承重待核实，请先根据结构图确认墙体属性");return}if(t.bearing){Te("这是承重墙，不能拆除");return}',
);
adapt(
  ':w.bearing?\'<button class="btn" disabled>承重墙不可拆除',
  ':window.__wallStructure?.(w)==="unknown"&&w.status!=="removed"?\'<button class="btn" disabled>承重待核实，暂不可拆除</button>\':w.bearing?\'<button class="btn" disabled>承重墙不可拆除',
);
export function editorHtml(project, variant) {
  const preset = {
    id: `housediy-${project.id}-${variant.id}`,
    plan: variant.plan,
    underlay: project.underlay,
    designPreferences: project.designPreferences,
  };
  const payload = `<script data-housediy-desktop id="__preset">window.__PRESET__=${encode(preset)};window.__HOUSEDIY__=${encode({ projectId: project.id, variantId: variant.id })}</script><script data-housediy-desktop src="/editor-models.js"></script><script data-housediy-desktop src="/editor-shapes.js"></script>`;
  // Both the attribution and the structural controls survive standalone export.
  const sharedHead = `<script>window.__wallStructure=${wallStructure.toString()};\n${structure}</script>\n<!--\n${license.replaceAll("-->", "--&gt;")}\n-->`;
  return template
    .replace(/<meta charset[^>]*>/i, (m) => m + sharedHead + payload)
    .replace(
      "</head>",
      '<link data-housediy-desktop rel="stylesheet" href="/design-tokens.css"><link data-housediy-desktop rel="stylesheet" href="/editor-theme.css"></head>',
    )
    .replace(
      "</body>",
      '<script data-housediy-desktop src="/editor-workspace.js"></script><script data-housediy-desktop src="/editor-bridge.js"></script></body>',
    );
}
