import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { openingTypes, parseOperation } from "./operations.mjs";

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
  for (const key of arrayKeys)
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
  for (const o of p.openings) {
    const w = walls.get(o.wall);
    if (!w || !openingTypes.includes(o.type))
      throw new Error("门窗的所属墙或类型无效");
    number(o.pos, "门窗位置", 0, w.length);
    number(o.width, "门窗宽度", 100, 20000);
    number(o.sill ?? 0, "窗台高度", 0, p.height);
    number(o.head ?? 2100, "门窗顶高", 100, p.height);
    if (o.head <= (o.sill ?? 0)) throw new Error("门窗顶高必须高于窗台");
    if (o.pos - o.width / 2 < -20 || o.pos + o.width / 2 > w.length + 20)
      throw new Error("门窗超出所属墙段，请先调整墙段或门窗宽度");
  }
  for (const f of p.furniture) {
    string(f.key, "家具类型");
    string(f.name, "家具名称");
    for (const k of ["x", "y"]) number(f[k], `家具 ${k}`);
    for (const k of ["w", "d", "h"]) number(f[k], `家具 ${k}`, 1, 30000);
    number(f.rot ?? 0, "旋转角度", -36000, 36000);
  }
  for (const r of p.rooms) {
    string(r.name, "房间名");
    number(r.x, "房间 X");
    number(r.y, "房间 Y");
  }
  p.prices ??= {};
  p.mep ??= { power: "floor", water: "ceil", edits: {} };
  p.look ??= { style: "real", palette: "plan" };
  return p;
}
export function newFurniture(key, fields = {}) {
  if (!catalog[key]) throw new Error(`家具库没有 ${key}，请先搜索家具库`);
  const f = { ...structuredClone(catalog[key]), id: id() };
  for (const k of ["x", "y", "w", "d", "h", "rot", "z", "color", "name"])
    if (fields[k] !== undefined) f[k] = fields[k];
  return f;
}
const cross = (ax, ay, bx, by) => ax * by - ay * bx;
export function normalizeWalls(plan) {
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
    const ts = [
      ...new Set(breaks.get(w.id).map((n) => Math.round(n * 1e8) / 1e8)),
    ].sort((a, b) => a - b);
    const segments = [];
    for (let i = 1; i < ts.length; i++) {
      const from = ts[i - 1],
        to = ts[i];
      if ((to - from) * len < 5) continue;
      const piece = {
        ...w,
        id: i === 1 ? w.id : id(),
        a: nodeAt(a.x + (b.x - a.x) * from, a.y + (b.y - a.y) * from),
        b: nodeAt(a.x + (b.x - a.x) * to, a.y + (b.y - a.y) * to),
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
    if (w.bearing)
      throw new Error(
        "AI 不修改标记为承重的墙，请在现场核实结构后由专业人员处理",
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
        bearingFrom: "inferred",
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
                other.bearing && (other.a === n.id || other.b === n.id),
            )
          )
            throw new Error("该端点连接承重墙，不能通过 AI 移动");
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
export function sceneContext(plan, selection) {
  const nodes = new Map(plan.nodes.map((n) => [n.id, n]));
  return {
    name: plan.name,
    units: "mm; x 向右,y 向下; 家具坐标是中心",
    height: plan.height,
    selection,
    walls: plan.walls.map((w) => ({
      ...w,
      a: nodes.get(w.a),
      b: nodes.get(w.b),
    })),
    openings: plan.openings,
    rooms: plan.rooms.map(({ id, name, x, y, mat, wallMat }) => ({
      id,
      name,
      x,
      y,
      mat,
      wallMat,
    })),
    furniture: plan.furniture.map(
      ({ id, key, name, x, y, w, d, h, rot, z, color }) => ({
        id,
        key,
        name,
        x,
        y,
        w,
        d,
        h,
        rot,
        z,
        color,
      }),
    ),
  };
}
export function fromRecognition(data, image, options = {}) {
  if (
    !data ||
    !Array.isArray(data.walls) ||
    data.walls.length < 3 ||
    data.walls.length > 250
  )
    throw new Error(
      "模型没有返回可用墙体，请换一张更清晰的户型图或更换看图模型",
    );
  const scale = number(data.scale?.mmPerPixel, "图片比例", 0.1, 500),
    height = number(options.height ?? 2800, "层高", 1800, 12000);
  const p = emptyPlan(
    string(data.name ?? options.name ?? "新户型", "户型名称"),
    height,
  );
  const px = (pointValue) =>
    point(pointValue, "图片坐标").map((n, i) => {
      number(n, "图片坐标", -10, (i ? image.height : image.width) + 10);
      return Math.round(n * scale);
    });
  const nodeAt = (v) => {
    let n = p.nodes.find((n) => Math.hypot(n.x - v[0], n.y - v[1]) < 15);
    if (!n) {
      n = { id: id(), x: v[0], y: v[1] };
      p.nodes.push(n);
    }
    return n.id;
  };
  for (const wall of data.walls)
    p.walls.push({
      id: id(),
      a: nodeAt(px(wall.a)),
      b: nodeAt(px(wall.b)),
      t: number(wall.thickness ?? 120, "墙厚", 50, 800),
      bearing: wall.bearing === true,
      bearingFrom: "inferred",
      status: "existing",
    });
  for (const o of data.openings ?? []) {
    const w = p.walls[o.wall];
    if (!w) throw new Error("识图结果中门窗引用了不存在的墙");
    const a = p.nodes.find((n) => n.id === w.a),
      b = p.nodes.find((n) => n.id === w.b),
      at = px(o.center),
      len = Math.hypot(b.x - a.x, b.y - a.y),
      pos = ((at[0] - a.x) * (b.x - a.x) + (at[1] - a.y) * (b.y - a.y)) / len;
    p.openings.push({
      id: id(),
      wall: w.id,
      type: o.type ?? "door",
      pos: Math.round(pos),
      width: number(o.width ?? 800, "门窗宽度", 100, 20000),
      sill: o.sill ?? (/window/i.test(o.type) ? 900 : 0),
      head: Math.min(o.head ?? 2100, height),
      hinge: 0,
      side: 1,
    });
  }
  for (const r of data.rooms ?? []) {
    const [x, y] = px(r.at);
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
  }
  normalizeWalls(p);
  validatePlan(p);
  const assumptions = [
    ...(Array.isArray(data.assumptions)
      ? data.assumptions.filter((x) => typeof x === "string").slice(0, 20)
      : []),
    "墙体承重属性来自图像推断，改造前需现场核实。",
  ];
  if (data.scale?.source !== "dimension")
    assumptions.unshift("图纸比例为估算，请根据实际尺寸校正。");
  const schemes =
    Array.isArray(data.schemes) && data.schemes.length
      ? data.schemes.slice(0, 3)
      : [
          {
            name: "原始户型",
            description: "先确认墙体，再继续布置家具。",
            furniture: [],
          },
        ];
  const variants = schemes.map((s) => {
    const plan = structuredClone(p);
    plan.name = string(s.name ?? "设计方案", "方案名称");
    for (const f of s.furniture ?? []) {
      const [x, y] = px(f.at);
      plan.furniture.push(newFurniture(f.key, { ...f, x, y }));
    }
    return {
      name: plan.name,
      description:
        typeof s.description === "string" ? s.description.slice(0, 1000) : "",
      plan: validatePlan(plan),
    };
  });
  return {
    name: p.name,
    variants,
    assumptions,
    underlay: {
      src: image.dataUrl,
      imgW: image.width,
      imgH: image.height,
      mmPerPx: scale,
      x: 0,
      y: 0,
      opacity: 0.5,
      visible: false,
      locked: true,
    },
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
