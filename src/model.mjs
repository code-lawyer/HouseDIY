import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { openingTypes, parseOperation } from "./operations.mjs";
import { validateOpening, projectAlongWall } from "./opening-placement.mjs";
import { wallStructure } from "./design-rules.mjs";

export const catalog = JSON.parse(
  readFileSync(new URL("../vendor/catalog.json", import.meta.url), "utf8"),
);
export const id = () => randomUUID().replaceAll("-", "").slice(0, 16);
export const revision = (plan) =>
  createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 20);
export const floorMaterials = [
  "oak",
  "walnut",
  "herring",
  "tile",
  "marble",
  "cement",
  "bath",
  "terrazzo",
  "deck",
  "paving",
  "grass",
  "epoxy",
];
export const wallMaterials = [
  "latexWhite",
  "latexGrey",
  "latexSage",
  "latexWarm",
  "wallpaper",
  "wallTile",
  "woodPanel",
];
const arrayKeys = [
  "nodes",
  "walls",
  "openings",
  "furniture",
  "rooms",
  "structs",
  "beams",
  "measures",
  "elec",
  "voids",
  "comments",
];
// The pinned renderer indexes these two tables directly while building a floor.
// Preserve its defaults when reading older plans that omitted optional fields.
const deviceHeights = {
  socket: 300,
  socketUSB: 700,
  socketW: 1400,
  socket16: 300,
  socketAC: 2200,
  socketHood: 2150,
  socketEV: 1300,
  socketFloor: 0,
  panel: 1800,
  switch1: 1300,
  switch2: 1300,
  switch3: 1300,
  dimmer: 1300,
  light: 0,
  pendant: 0,
  downlight: 0,
  spot: 0,
  wallLamp: 1700,
  strip: 0,
  track: 0,
  linear: 0,
  weak: 300,
  net: 300,
  tv: 1100,
  intercom: 1400,
  smoke: 0,
  cold: 500,
  hot: 500,
  waterIn: 300,
  waste: 400,
  acHole: 2350,
  freshAir: 0,
  gas: 600,
};
const structureSizes = {
  column: [400, 400],
  shaft: [600, 400],
  flue: [450, 350],
  drain: [120, 120],
  sewer: [160, 160],
};
export function number(value, label, min = -100000, max = 100000) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new Error(`${label} 超出允许范围`);
  return value;
}
export function string(value, label, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${label} 格式不正确`);
  return value.trim();
}
const point = (value, label) => {
  if (!Array.isArray(value) || value.length !== 2)
    throw new Error(`${label} 应为 [x,y]`);
  return value.map((v) => number(v, label));
};
const color = (value) => {
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error("颜色应为 #RRGGBB");
  return value;
};
function position(item, path) {
  number(item?.x, path + ".x");
  number(item?.y, path + ".y");
}
function validateFixtures(plan) {
  for (const e of plan.elec) {
    const path = `elec[${e.id}]`;
    if (typeof e.kind !== "string" || !Object.hasOwn(deviceHeights, e.kind))
      throw new Error(`${path}.kind 水电点位类型不受当前设计器支持`);
    position(e, path);
    number((e.h ??= deviceHeights[e.kind]), path + ".h", 0);
    number((e.rot ??= 0), path + ".rot");
    if (
      e.links != null &&
      (!Array.isArray(e.links) || e.links.some((id) => typeof id !== "string"))
    )
      throw new Error(`${path}.links 应为连接的点位 ID 列表`);
  }
  for (const s of plan.structs) {
    const path = `structs[${s.id}]`;
    if (typeof s.kind !== "string" || !Object.hasOwn(structureSizes, s.kind))
      throw new Error(`${path}.kind 固定构件类型不受当前设计器支持`);
    position(s, path);
    number((s.w ??= structureSizes[s.kind][0]), path + ".w", 1);
    number((s.d ??= structureSizes[s.kind][1]), path + ".d", 1);
    number((s.rot ??= 0), path + ".rot");
  }
  for (const key of ["beams", "measures"]) {
    for (const item of plan[key]) {
      const path = `${key}[${item.id}]`;
      position(item.a, path + ".a");
      position(item.b, path + ".b");
      if (key === "beams") {
        number((item.w ??= 200), path + ".w", 1);
        number((item.depth ??= 400), path + ".depth", 1);
      }
    }
  }
  for (const v of plan.voids) {
    const path = `voids[${v.id}]`;
    position(v, path);
    number(v.w, path + ".w", 1);
    number(v.h, path + ".h", 1);
  }
  for (const c of plan.comments) {
    const path = `comments[${c.id}]`;
    position(c, path);
    c.replies ??= [];
    if (
      !Array.isArray(c.replies) ||
      c.replies.some((r) => !r || typeof r !== "object")
    )
      throw new Error(`${path}.replies 应为回复列表`);
  }
}
export function emptyPlan(name = "新方案", height = 2800) {
  return {
    version: 2,
    name,
    height,
    phase: "renovate",
    ...Object.fromEntries(arrayKeys.map((k) => [k, []])),
    prices: {},
    mep: { power: "floor", water: "ceil", edits: {} },
    look: { style: "real", palette: "plan", labels: false },
  };
}
function uniqueIds(plan) {
  const seen = new Set();
  for (const key of [
    ...arrayKeys,
    ...(plan.pendingOpenings ? ["pendingOpenings"] : []),
  ])
    for (const item of plan[key]) {
      if (
        !item ||
        typeof item !== "object" ||
        typeof item.id !== "string" ||
        !item.id ||
        seen.has(item.id)
      )
        throw new Error(`${key} 中有重复或缺失的对象 ID`);
      seen.add(item.id);
    }
}
export function validatePlan(input) {
  if (
    !input ||
    input.version !== 2 ||
    !["nodes", "walls", "openings", "furniture", "rooms"].every((k) =>
      Array.isArray(input[k]),
    )
  )
    throw new Error("需要单层设计器方案 JSON（version: 2）");
  const p = structuredClone(input);
  for (const key of arrayKeys) {
    p[key] ??= [];
    if (!Array.isArray(p[key]) || p[key].length > 3000)
      throw new Error(`${key} 数据过大或格式不正确`);
  }
  string(p.name, "方案名称");
  number(p.height, "层高", 1800, 12000);
  if (p.pendingOpenings !== undefined) {
    if (!Array.isArray(p.pendingOpenings) || p.pendingOpenings.length > 500)
      throw new Error("待定位门窗数据格式不正确");
    for (const o of p.pendingOpenings) {
      if (!o || !openingTypes.includes(o.type))
        throw new Error("待定位门窗类型无效");
      if (o.pixel !== null) point(o.pixel, "门窗原图位置");
      string(o.reason, "门窗待确认原因");
      number(o.ordinal, "门窗原图编号", 1, 500);
      number(o.width, "待定位门窗宽度", 100, 20000);
    }
  }
  uniqueIds(p);
  const nodes = new Map(
    p.nodes.map((n) => {
      number(n.x, "节点 X");
      number(n.y, "节点 Y");
      return [n.id, n];
    }),
  );
  const walls = new Map(
    p.walls.map((w) => {
      const a = nodes.get(w.a),
        b = nodes.get(w.b);
      if (!a || !b || Math.hypot(a.x - b.x, a.y - b.y) < 10)
        throw new Error("墙端点缺失或墙长不足 10 mm");
      number(w.t, "墙厚", 40, 2000);
      // Repair plans saved by 0.1.0; the upstream renderer uses "removed".
      if (w.status === "demolish") w.status = "removed";
      return [w.id, { ...w, length: Math.hypot(a.x - b.x, a.y - b.y) }];
    }),
  );
  for (const o of p.openings)
    validateOpening(o, walls.get(o.wall)?.length, p.height);
  for (const f of p.furniture) validateFurniture(f);
  for (const r of p.rooms) {
    string(r.name, "房间名");
    number(r.x, "房间 X");
    number(r.y, "房间 Y");
  }
  validateFixtures(p);
  p.prices ??= {};
  p.mep ??= { power: "floor", water: "ceil", edits: {} };
  p.look ??= { style: "real", palette: "plan" };
  return p;
}
function validateFurniture(f) {
  string(f.key, "家具类型");
  string(f.name, "家具名称");
  for (const k of ["x", "y"]) number(f[k], `家具 ${k}`);
  for (const k of ["w", "d", "h"]) number(f[k], `家具 ${k}`, 1, 30000);
  number(f.rot ?? 0, "旋转角度", -36000, 36000);
  number(f.z ?? 0, "家具离地高度");
}
export function newFurniture(key, fields = {}) {
  if (!catalog[key]) throw new Error(`家具库没有 ${key}，请先搜索家具库`);
  const f = { ...structuredClone(catalog[key]), id: id() };
  for (const k of ["x", "y", "w", "d", "h", "rot", "z", "color", "name"])
    if (fields[k] !== undefined) f[k] = fields[k];
  return f;
}
const cross = (ax, ay, bx, by) => ax * by - ay * bx;
export function normalizeWalls(plan, maxPieces = Infinity) {
  const nodes = new Map(plan.nodes.map((n) => [n.id, n]));
  const source = plan.walls.filter(
    (w) => !["removed", "demolish"].includes(w.status),
  );
  const breaks = new Map(source.map((w) => [w.id, [0, 1]]));
  for (let i = 0; i < source.length; i++)
    for (let j = i + 1; j < source.length; j++) {
      const a = nodes.get(source[i].a),
        b = nodes.get(source[i].b),
        c = nodes.get(source[j].a),
        d = nodes.get(source[j].b);
      const ux = b.x - a.x,
        uy = b.y - a.y,
        vx = d.x - c.x,
        vy = d.y - c.y,
        den = cross(ux, uy, vx, vy);
      if (Math.abs(den) < 1e-6) continue;
      const t = cross(c.x - a.x, c.y - a.y, vx, vy) / den,
        u = cross(c.x - a.x, c.y - a.y, ux, uy) / den;
      if (t >= -1e-6 && t <= 1.000001 && u >= -1e-6 && u <= 1.000001) {
        breaks.get(source[i].id).push(Math.max(0, Math.min(1, t)));
        breaks.get(source[j].id).push(Math.max(0, Math.min(1, u)));
      }
    }
  // Dense recognition output can have many thousands of intersections.
  // Keep the original drawable segments if a split would exceed the plan format.
  if (Number.isFinite(maxPieces)) {
    let pieces = 0;
    for (const ts of breaks.values()) pieces += new Set(ts).size - 1;
    if (pieces > maxPieces) return plan;
  }
  const nodeAt = (x, y) => {
    let n = plan.nodes.find((n) => Math.hypot(n.x - x, n.y - y) < 2);
    if (!n) {
      n = { id: id(), x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
      plan.nodes.push(n);
    }
    return n.id;
  };
  const next = [],
    openingMap = new Map();
  for (const w of plan.walls) {
    if (["removed", "demolish"].includes(w.status)) {
      w.status = "removed";
      next.push(w);
      continue;
    }
    const a = nodes.get(w.a),
      b = nodes.get(w.b),
      len = Math.hypot(b.x - a.x, b.y - a.y);
    const rawTs = [
      ...new Set(breaks.get(w.id).map((n) => Math.round(n * 1e8) / 1e8)),
    ].sort((a, b) => a - b);
    const ts = [0];
    for (const t of rawTs) {
      if (t <= 0 || t >= 1) continue;
      // Keep the full original span when a cut would make a wall too short
      // for validatePlan. Dropping the short piece would move the endpoint.
      if ((t - ts.at(-1)) * len >= 10 && (1 - t) * len >= 10) ts.push(t);
    }
    ts.push(1);
    const segments = [];
    for (let i = 1; i < ts.length; i++) {
      const from = ts[i - 1],
        to = ts[i];
      const piece = {
        ...w,
        id: i === 1 ? w.id : id(),
        a:
          from === 0
            ? w.a
            : nodeAt(a.x + (b.x - a.x) * from, a.y + (b.y - a.y) * from),
        b:
          to === 1
            ? w.b
            : nodeAt(a.x + (b.x - a.x) * to, a.y + (b.y - a.y) * to),
      };
      next.push(piece);
      segments.push({ id: piece.id, from: from * len, to: to * len });
    }
    openingMap.set(w.id, segments);
  }
  for (const o of plan.openings) {
    const parts = openingMap.get(o.wall);
    if (!parts) continue;
    const part = parts.find((s) => o.pos >= s.from - 1 && o.pos <= s.to + 1);
    if (part) {
      o.wall = part.id;
      o.pos -= part.from;
    }
  }
  plan.walls = next;
  return plan;
}
export function applyOperations(input, operations) {
  if (
    !Array.isArray(operations) ||
    !operations.length ||
    operations.length > 80
  )
    throw new Error("每次修改需要 1–80 项操作");
  const p = validatePlan(input),
    summary = [];
  let structural = false;
  const find = (list, idValue) => {
    const obj = p[list].find((x) => x.id === idValue);
    if (!obj) throw new Error(`找不到对象 ${idValue}，请重新读取方案`);
    return obj;
  };
  const protectedWall = (w) => {
    const structure = wallStructure(w);
    if (structure === "bearing")
      throw new Error(
        "AI 不修改标记为承重的墙，请在现场核实结构后由专业人员处理",
      );
    if (structure === "unknown")
      throw new Error(
        "墙体承重属性尚未核实，AI 不能拆改墙体或门窗。请先依据结构图核实并在原始结构中标明。",
      );
  };
  const setNumeric = (target, op, keys, min = -100000, max = 100000) => {
    for (const key of keys)
      if (op[key] !== undefined) target[key] = number(op[key], key, min, max);
  };
  for (const raw of operations) {
    const op = parseOperation(raw);
    if (op.op === "add_furniture") {
      const f = newFurniture(string(op.key, "家具类型"), op);
      number(f.x, "X");
      number(f.y, "Y");
      if (op.color !== undefined) color(op.color);
      p.furniture.push(f);
      summary.push(`添加 ${f.name}`);
    } else if (op.op === "update_furniture") {
      const f = find("furniture", op.id);
      setNumeric(f, op, ["x", "y", "z", "rot"]);
      setNumeric(f, op, ["w", "d", "h"], 1, 30000);
      if (op.color !== undefined) f.color = color(op.color);
      if (op.name !== undefined) f.name = string(op.name, "家具名称");
      summary.push(`调整 ${f.name}`);
    } else if (op.op === "remove_furniture") {
      const f = find("furniture", op.id);
      p.furniture = p.furniture.filter((x) => x.id !== f.id);
      summary.push(`移除 ${f.name}`);
    } else if (op.op === "update_room") {
      const r = find("rooms", op.id);
      if (op.name !== undefined) r.name = string(op.name, "房间名称");
      setNumeric(r, op, ["x", "y"]);
      if (op.mat !== undefined) {
        if (!floorMaterials.includes(op.mat))
          throw new Error("不支持该地面材质");
        r.mat = op.mat;
      }
      if (op.wallMat !== undefined) {
        if (!wallMaterials.includes(op.wallMat))
          throw new Error("不支持该墙面材质");
        r.wallMat = op.wallMat;
      }
      summary.push(`调整 ${r.name} 的材质或名称`);
    } else if (op.op === "add_room") {
      p.rooms.push({
        id: id(),
        name: string(op.name, "房间名称"),
        x: number(op.x, "房间 X"),
        y: number(op.y, "房间 Y"),
        mat: "oak",
        wallMat: "latexWhite",
      });
      summary.push(`标明 ${op.name} 的用途`);
    } else if (op.op === "add_wall") {
      const a = point(op.a, "墙起点"),
        b = point(op.b, "墙终点");
      const nodeAt = (v) => {
        let n = p.nodes.find((n) => Math.hypot(n.x - v[0], n.y - v[1]) < 5);
        if (!n) {
          n = { id: id(), x: v[0], y: v[1] };
          p.nodes.push(n);
        }
        return n.id;
      };
      p.walls.push({
        id: id(),
        a: nodeAt(a),
        b: nodeAt(b),
        t: number(op.t ?? 100, "墙厚", 40, 600),
        bearing: false,
        bearingFrom: "design",
        status: "new",
      });
      structural = true;
      summary.push("新增非承重隔墙方案");
    } else if (op.op === "update_wall") {
      const w = find("walls", op.id);
      protectedWall(w);
      if (op.t !== undefined) w.t = number(op.t, "墙厚", 40, 600);
      for (const end of ["a", "b"])
        if (op[end] !== undefined) {
          const n = find("nodes", w[end]),
            v = point(op[end], "墙端点");
          if (
            p.walls.some(
              (other) =>
                wallStructure(other) !== "partition" &&
                (other.a === n.id || other.b === n.id),
            )
          )
            throw new Error(
              "该端点连接承重墙或承重待核实的墙，不能通过 AI 移动",
            );
          n.x = v[0];
          n.y = v[1];
        }
      structural = true;
      summary.push("调整隔墙位置或厚度");
    } else if (op.op === "remove_wall") {
      const w = find("walls", op.id);
      protectedWall(w);
      w.status = "removed";
      structural = true;
      summary.push("将隔墙标记为拆除方案");
    } else if (op.op === "add_opening") {
      const w = find("walls", op.wallId);
      protectedWall(w);
      const type = op.type ?? "door";
      if (!openingTypes.includes(type)) throw new Error("门窗类型无效");
      const isWindow = /window|bay|glass/i.test(type);
      p.openings.push({
        id: id(),
        wall: w.id,
        type,
        pos: number(op.pos, "门窗距墙起点距离", 0),
        width: number(
          op.width ?? (isWindow ? 1200 : 800),
          "门窗宽度",
          100,
          20000,
        ),
        sill: number(op.sill ?? (isWindow ? 900 : 0), "窗台高", 0, p.height),
        head: number(op.head ?? 2100, "顶高", 100, p.height),
        hinge: op.hinge === 1 ? 1 : 0,
        side: op.side === -1 ? -1 : 1,
      });
      structural = true;
      summary.push(`新增${isWindow ? "窗" : "门洞"}方案`);
    } else if (op.op === "update_opening" || op.op === "remove_opening") {
      const o = find("openings", op.id);
      protectedWall(find("walls", o.wall));
      if (op.op === "remove_opening") {
        p.openings = p.openings.filter((x) => x.id !== o.id);
        summary.push("移除门窗方案");
      } else {
        setNumeric(o, op, ["pos", "width", "sill", "head"], 0, 30000);
        for (const key of ["type", "hinge", "side"])
          if (op[key] !== undefined) o[key] = op[key];
        summary.push("调整门窗类型、尺寸、位置或开启方向");
      }
      structural = true;
    } else throw new Error(`不支持的操作 ${op.op}`);
  }
  if (structural) normalizeWalls(p);
  return {
    plan: validatePlan(p),
    summary,
    structural,
    warnings: structural
      ? ["墙体与门窗改造仅用于方案讨论，承重属性及现场条件需复核。"]
      : [],
  };
}
function siteNote(comment) {
  const note = { id: comment.id };
  if (typeof comment.text === "string")
    note.text =
      comment.text.length > 240 ? comment.text.slice(0, 240) : comment.text;
  if (comment.x != null) note.x = comment.x;
  if (comment.y != null) note.y = comment.y;
  if (comment.resolved != null) note.resolved = comment.resolved;
  return note;
}
function servicePoint(item) {
  const point = { id: item.id, kind: item.kind, x: item.x, y: item.y };
  if (item.h != null) point.h = item.h;
  if (item.name) point.name = item.name;
  if (item.rot != null) point.rot = item.rot;
  if (Array.isArray(item.pts)) point.points = item.pts.length;
  if (Array.isArray(item.links) && item.links.length)
    point.links = item.links.slice(0, 8);
  return point;
}
function mepSummary(mep = {}) {
  const edits = mep.edits && typeof mep.edits === "object" ? mep.edits : {};
  return {
    ...(mep.power != null ? { power: mep.power } : {}),
    ...(mep.water != null ? { water: mep.water } : {}),
    editCount: Object.keys(edits).length,
  };
}
export function sceneContext(plan, selection) {
  const nodes = new Map(plan.nodes.map((n) => [n.id, n]));
  const scene = {
    name: plan.name,
    units: "mm; x 向右,y 向下; 家具坐标是中心",
    height: plan.height,
    phase: plan.phase,
    selection,
    walls: plan.walls.map((w) => ({
      ...w,
      bearingStatus: wallStructure(w),
      a: nodes.get(w.a),
      b: nodes.get(w.b),
    })),
    openings: plan.openings,
    furniture: plan.furniture.map(
      ({ model, parts, b64, icon, top, opt, ...item }) => {
        if (opt) {
          // The upstream shape editor stores its serialized mesh under opt.model.
          const { model, parts, fp, ...options } = opt;
          item.opt = options;
        }
        return item;
      },
    ),
    rooms: plan.rooms,
    structs: plan.structs.map((item) => ({ ...item })),
    beams: plan.beams.map((item) => ({ ...item })),
    measures: plan.measures.map((item) => ({ ...item })),
    voids: plan.voids.map((item) => ({ ...item })),
    comments: plan.comments.map(siteNote),
    elec: plan.elec.map(servicePoint),
    mep: mepSummary(plan.mep),
  };
  if (Array.isArray(plan.pendingOpenings))
    scene.pendingOpenings = plan.pendingOpenings.map((item) => ({ ...item }));
  return scene;
}
// Compatible vision services sometimes quote numbers or use named pixel coordinates.
// Keep these conversions confined to recognition; saved plans and AI edits stay strict.
function recognitionNumber(value) {
  if (
    typeof value === "string" &&
    /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())
  )
    return Number(value);
  return value;
}
function recognizedStructure(data, image, options) {
  if (!data || !Array.isArray(data.walls) || !data.walls.length)
    throw new Error("没有识别到可建模的墙体。");
  const height = number(options.height ?? 2800, "层高", 1800, 12000);
  const pixels = (coord) => {
    const pair = Array.isArray(coord) ? coord : [coord?.x, coord?.y];
    return point(pair.map(recognitionNumber), "图片坐标").map((n, i) =>
      number(n, "图片坐标", -10, (i ? image.height : image.width) + 10),
    );
  };
  const assumptions = [],
    geometryIssues = [];
  const note = (text) => {
    if (geometryIssues.length < 20) geometryIssues.push(text);
  };
  const wallInputs = new Map();
  if (data.walls.length > 250) note("墙线超过本次处理上限，已取前 250 段。");
  for (const [index, wall] of data.walls.slice(0, 250).entries()) {
    try {
      const a = pixels(wall?.a),
        b = pixels(wall?.b);
      if (a[0] === b[0] && a[1] === b[1]) throw new Error("两端重合");
      const thickness = recognitionNumber(wall.thickness ?? 120);
      const hasThickness =
        Number.isFinite(thickness) && thickness >= 50 && thickness <= 800;
      if (!hasThickness)
        note(`墙线 ${index + 1} 的厚度待核对，暂按 120 mm 绘制。`);
      wallInputs.set(index, {
        ...wall,
        a,
        b,
        t: hasThickness ? thickness : 120,
      });
    } catch (error) {
      note(`墙线 ${index + 1} 待描。形状或尺寸无法使用（${error.message}）。`);
    }
  }
  if (!wallInputs.size) throw new Error("未识别到有效墙体，可在底图上描墙。");
  const ends = [...wallInputs.values()].flatMap((w) => [w.a, w.b]);
  const xs = ends.map(([x]) => x),
    left = Math.min(...xs),
    span = Math.max(...xs) - left;
  let offsetX = 0,
    offsetY = 0;
  let scale;
  if (
    options.widthMeters != null &&
    span >= 1 &&
    (options.widthMeters * 1000) / span <= 10000
  ) {
    const width = number(options.widthMeters, "户型跨度", 1, 100);
    scale = number(
      (width * 1000) / span,
      "根据左右墙线计算的底图比例",
      0.01,
      10000,
    );
    offsetX = -left * scale;
    offsetY = -Math.min(...ends.map(([, y]) => y)) * scale;
    const predicted = (data.scale?.mmPerPixel * span) / 1000;
    const mismatch =
      Number.isFinite(predicted) && Math.abs(predicted - width) > width * 0.02;
    assumptions.push(
      (mismatch
        ? `识图比例对应约 ${Number(predicted.toFixed(2))} 米，与填写值有差异。`
        : "") +
        `已按左右最外墙中线的指定跨度 ${width} 米校准底图和方案，请核对识别出的两侧墙线。`,
    );
  } else {
    const supplied = recognitionNumber(data.scale?.mmPerPixel);
    const hasScale =
      Number.isFinite(supplied) && supplied >= 0.1 && supplied <= 500;
    scale = hasScale
      ? supplied
      : Math.min(10000, ((options.widthMeters ?? 10) * 1000) / image.width);
    if (options.widthMeters != null)
      assumptions.push("当前墙线不足以确定左右跨度，请在原图上校准尺寸。");
    if (!hasScale || data.scale?.source !== "dimension")
      assumptions.push("图纸比例为估算，请根据实际尺寸校正。");
  }
  const p = emptyPlan(
    (typeof data.name === "string" && data.name.trim().slice(0, 200)) ||
      options.name ||
      "新户型",
    height,
  );
  const px = (coord) =>
    pixels(coord).map((n, i) =>
      number(Math.round(n * scale + (i ? offsetY : offsetX)), "平面坐标"),
    );
  const nodeAt = (v) => {
    let n = p.nodes.find((n) => Math.hypot(n.x - v[0], n.y - v[1]) < 15);
    if (!n) {
      n = { id: id(), x: v[0], y: v[1] };
      p.nodes.push(n);
    }
    return n.id;
  };
  const sourceWalls = new Map();
  for (const [index, wall] of wallInputs) {
    try {
      const start = px(wall.a),
        end = px(wall.b);
      const a = nodeAt(start),
        b = nodeAt(end);
      if (a === b) throw new Error("墙端点重合");
      const w = {
        id: id(),
        a,
        b,
        t: wall.t,
        bearing: typeof wall.bearing === "boolean" ? wall.bearing : null,
        bearingFrom: "inferred",
        status: "existing",
      };
      p.walls.push(w);
      sourceWalls.set(index, w);
    } catch (error) {
      note(`墙线 ${index + 1} 待描（${error.message}）。`);
    }
  }
  if (!p.walls.length)
    throw new Error("未识别到可绘制的墙体，可在底图上描墙。");
  const sourceOpenings = new Map(),
    pending = [];
  function objects(value, label, limit) {
    if (value == null) return [];
    if (!Array.isArray(value)) {
      note(`${label}数据无法读取，请对照底图补充。`);
      return [];
    }
    if (value.length > limit)
      note(`${label}超过本次处理上限，已取前 ${limit} 个。`);
    return value.slice(0, limit);
  }
  const openings = objects(data.openings, "门窗", 500);
  function deferOpening(o, reason) {
    const { pixel, ordinal, ...fields } = sourceOpenings.get(o.id);
    pending.push({
      ...fields,
      pixel,
      ordinal,
      reason,
      type: openingTypes.includes(o.type) ? o.type : "door",
      width:
        Number.isFinite(o.width) && o.width >= 100 && o.width <= 20000
          ? o.width
          : 800,
      sill:
        Number.isFinite(o.sill) && o.sill >= 0 && o.sill < height ? o.sill : 0,
      head:
        Number.isFinite(o.head) && o.head >= 100 && o.head <= height
          ? o.head
          : Math.min(2100, height),
    });
  }
  for (const [index, raw] of openings.entries()) {
    const o = raw ?? {};
    const item = {
      id: id(),
      type: o.type ?? "door",
      width: recognitionNumber(o.width ?? 800),
      sill: recognitionNumber(o.sill ?? (/window|bay/i.test(o.type) ? 900 : 0)),
      head: recognitionNumber(o.head ?? Math.min(2100, height)),
      hinge: o.hinge === 1 ? 1 : 0,
      side: o.side === -1 ? -1 : 1,
    };
    const source = { ...item, ordinal: index + 1, pixel: null };
    sourceOpenings.set(item.id, source);
    try {
      source.pixel = pixels(o.center);
      const w = sourceWalls.get(recognitionNumber(o.wall));
      if (!w) throw new Error("原图标注的所属墙未能识别");
      const a = p.nodes.find((n) => n.id === w.a),
        b = p.nodes.find((n) => n.id === w.b);
      const [x, y] = px(source.pixel);
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      const distance =
        Math.abs((x - a.x) * (b.y - a.y) - (y - a.y) * (b.x - a.x)) / length;
      const markingTolerance = Math.min(180, Math.max(50, 2 * scale));
      if (distance > w.t / 2 + markingTolerance)
        throw new Error("门窗中心离模型指定的墙过远");
      item.wall = w.id;
      item.pos = Math.round(projectAlongWall(a, b, x, y));
      validateOpening(item, length, height);
      p.openings.push(item);
    } catch (error) {
      deferOpening(item, error.message);
    }
  }
  for (const [index, r] of objects(data.rooms, "房间名称", 250).entries()) {
    try {
      const [x, y] = px(r?.at);
      p.rooms.push({
        id: id(),
        name: string(r.name, "房间名"),
        x,
        y,
        mat: floorMaterials.includes(r.mat)
          ? r.mat
          : /卫|厨/.test(r.name)
            ? "bath"
            : "oak",
        wallMat: "latexWhite",
      });
    } catch (error) {
      note(`第 ${index + 1} 个房间标注待补（${error.message}）。`);
    }
  }
  const splitInput = structuredClone(p),
    originalWalls = splitInput.walls;
  const split = normalizeWalls(splitInput, 3000);
  if (split.walls === originalWalls)
    note("墙线交点过多，已保留原始墙段，请核对交点。");
  if (split.nodes.length <= 3000 && split.walls.length <= 3000) {
    const nodes = new Map(split.nodes.map((n) => [n.id, n]));
    const lengths = new Map(
      split.walls.map((w) => {
        const a = nodes.get(w.a),
          b = nodes.get(w.b);
        return [w.id, Math.hypot(b.x - a.x, b.y - a.y)];
      }),
    );
    p.walls = split.walls.filter((w) => lengths.get(w.id) >= 10);
    const used = new Set(p.walls.flatMap((w) => [w.a, w.b]));
    p.nodes = split.nodes.filter((n) => used.has(n.id));
    p.openings = split.openings.filter((o) => {
      try {
        validateOpening(o, lengths.get(o.wall), height);
        return true;
      } catch (error) {
        deferOpening(o, error.message);
        return false;
      }
    });
  } else note("墙线交点过多，已保留识别到的原始墙段，请核对交点。");
  if (!p.walls.length)
    throw new Error("未识别到可绘制的墙体，可在底图上描墙。");
  if (p.walls.length < 3) note("墙线尚不完整，可在二维底图中继续描墙。");
  if (pending.length)
    p.pendingOpenings = pending.sort((a, b) => a.ordinal - b.ordinal);
  const base = validatePlan(p);
  assumptions.push(
    ...geometryIssues,
    ...(Array.isArray(data.assumptions)
      ? data.assumptions.filter((x) => typeof x === "string").slice(0, 20)
      : []),
    "墙体承重属性来自图像推断，改造前需现场核实。",
  );
  if (
    openings.some(
      (o) =>
        o &&
        !/window|bay|glass/i.test(o.type) &&
        (o.hinge == null || o.side == null),
    )
  )
    assumptions.push(
      "部分门的开启方向无法确认，已用默认方向示意，请对照原图核实。",
    );
  return {
    base,
    px,
    assumptions,
    geometryIssues: [
      ...geometryIssues,
      ...pending
        .slice(0, 8)
        .map((o) => `原图门窗 ${o.ordinal} 待定位（${o.reason}）。`),
    ],
    underlay: {
      src: image.dataUrl,
      imgW: image.width,
      imgH: image.height,
      mmPerPx: scale,
      x: offsetX,
      y: offsetY,
      opacity: 0.5,
      visible: false,
      locked: true,
    },
  };
}
export function fromRecognition(data, image, options = {}) {
  const { base, px, assumptions, geometryIssues, underlay } =
    recognizedStructure(data, image, options);
  const expectedCount = options.schemeCount ?? 1;
  if (
    !Number.isInteger(expectedCount) ||
    expectedCount < 1 ||
    expectedCount > 3
  )
    throw new Error("请选择 1–3 套方案");
  const schemes = Array.isArray(data.schemes) ? data.schemes : [],
    schemeIssues = [],
    variants = [],
    layouts = new Set();
  if (schemes.length < expectedCount)
    schemeIssues.push(
      `需要 ${expectedCount} 套方案，模型只返回 ${schemes.length} 套。`,
    );
  for (const [index, s] of schemes
    .slice(0, options.schemeCount ?? 3)
    .entries()) {
    try {
      if (!s || typeof s !== "object" || Array.isArray(s))
        throw new Error("方案数据格式不正确");
      if (!Array.isArray(s.furniture ?? []))
        throw new Error("家具数据格式不正确");
      const plan = structuredClone(base);
      plan.name =
        typeof s.name === "string" && s.name.trim()
          ? s.name.trim().slice(0, 200)
          : "设计方案";
      const furniture = (s.furniture ?? []).slice(0, 500);
      if (s.furniture?.length > 500)
        schemeIssues.push(
          `第 ${index + 1} 套方案家具超过上限，已取前 500 件。`,
        );
      const omitted = [];
      for (const [index, f] of furniture.entries()) {
        try {
          const [x, y] = px(f?.at);
          const fields = { ...f, x, y };
          for (const k of ["w", "d", "h", "rot", "z"])
            if (k in fields) fields[k] = recognitionNumber(fields[k]);
          const item = newFurniture(f.key, fields);
          validateFurniture(item);
          plan.furniture.push(item);
        } catch (error) {
          omitted.push(`家具 ${index + 1}（${error.message}）`);
        }
      }
      if (omitted.length) {
        const reason = `${omitted.length} 件家具待补。${omitted.slice(0, 3).join("、")}`;
        if (!plan.furniture.length) throw new Error(reason);
        schemeIssues.push(`第 ${index + 1} 套方案有 ${reason}`);
      }
      if (!plan.furniture.length) throw new Error("家具尚未布置");
      const valid = validatePlan(plan);
      const layout = JSON.stringify(
        valid.furniture
          .map((f) =>
            JSON.stringify([
              f.key,
              f.x,
              f.y,
              f.w,
              f.d,
              f.h,
              (((f.rot ?? 0) % 360) + 360) % 360,
              f.z ?? 0,
            ]),
          )
          .sort(),
      );
      if (layouts.has(layout)) {
        schemeIssues.push(
          `第 ${index + 1} 套方案的家具布置与另一套完全相同。请调整实际摆放。`,
        );
        continue;
      }
      layouts.add(layout);
      variants.push({
        name: valid.name,
        description:
          typeof s.description === "string" ? s.description.slice(0, 1000) : "",
        plan: valid,
      });
    } catch (error) {
      schemeIssues.push(`第 ${index + 1} 套方案无法建模。${error.message}`);
    }
  }
  const generatedSchemeCount = variants.length;
  if (!generatedSchemeCount) {
    const name = "户型结构草稿";
    variants.push({ name, description: "家具待布置", plan: { ...base, name } });
  }
  return {
    name: base.name,
    variants,
    assumptions,
    schemeIssues,
    geometryIssues,
    generatedSchemeCount,
    underlay,
  };
}
export function demoPlan() {
  const image = { width: 600, height: 450, dataUrl: "" };
  const r = fromRecognition(
    {
      name: "两个人的日光客厅",
      scale: { mmPerPixel: 10, source: "dimension" },
      walls: [
        { a: [20, 20], b: [580, 20], thickness: 200, bearing: true },
        { a: [580, 20], b: [580, 430], thickness: 200, bearing: true },
        { a: [580, 430], b: [20, 430], thickness: 200, bearing: true },
        { a: [20, 430], b: [20, 20], thickness: 200, bearing: true },
      ],
      openings: [
        {
          wall: 0,
          center: [300, 20],
          width: 2200,
          type: "window",
          sill: 800,
          head: 2300,
        },
        { wall: 3, center: [20, 340], width: 900, type: "door" },
      ],
      rooms: [{ name: "客厅", at: [300, 220] }],
      schemes: [
        {
          name: "日光客厅",
          description: "一个可直接体验编辑与 AI 对话的示例空间。",
          furniture: [
            { key: "sofa", at: [450, 220], rot: 90, color: "#b5a291" },
            { key: "coffeeTable", at: [300, 220], rot: 90 },
            { key: "tvCabinet", at: [70, 160], rot: 270 },
            { key: "plant", at: [530, 70] },
            { key: "rug", at: [300, 220], rot: 90 },
          ],
        },
      ],
    },
    image,
  );
  return r.variants[0].plan;
}
