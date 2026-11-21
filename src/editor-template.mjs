import { readFileSync } from "node:fs";
const base = new URL("../vendor/", import.meta.url);
const license = readFileSync(
  new URL("HOUSE-PLAN-DESIGNER-LICENSE", base),
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
  'await (window.houseModels?window.houseModels.load(()=>Fw("models")):Fw("models"))',
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
  "window.__houseModelsReady=fN().then(()=>{ki(),To()})",
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
adapt(
  "models:e,underlays:lI(),fmLib:Lh()",
  'models:e,underlays:lI().map((u,i)=>u?.src==="preset"?{...u,src:eh(i)?.src}:u),fmLib:Lh()',
);
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
  const payload = `<script data-housediy-desktop id="__preset">window.__PRESET__=${encode(preset)};window.__HOUSEDIY__=${encode({ projectId: project.id, variantId: variant.id })}</script><script data-housediy-desktop src="/editor-models.js"></script>`;
  return (
    template
      .replace(/<meta charset[^>]*>/i, (m) => m + payload)
      .replace(
        "</head>",
        '<link data-housediy-desktop rel="stylesheet" href="/design-tokens.css"><link data-housediy-desktop rel="stylesheet" href="/editor-theme.css"></head>',
      )
      .replace(
        "</body>",
        '<script data-housediy-desktop src="/editor-workspace.js"></script><script data-housediy-desktop src="/editor-bridge.js"></script></body>',
      ) +
    "\n<!--\n" +
    license +
    "\n-->"
  );
}
