// Shared by the model adapter and the editor. These are conservative product
// checks, not a building-code certification. Units are millimetres.
export const defaultDesignPreferences = {
  layoutLocked: true,
  allowFreestandingStorage: false,
};
export function wallStructure(wall) {
  if (wall.bearing === true) return "bearing";
  if (
    wall.bearing === false &&
    (wall.status === "new" || wall.bearingFrom !== "inferred")
  )
    return "partition";
  return "unknown";
}
const rad = Math.PI / 180;
const active = (w) => !["removed", "demolish"].includes(w.status);
const isWindow = (o) => /window|bay|glass/i.test(o.type);
const walkOpening = (o) => !isWindow(o) && (o.sill || 0) < 100;
const rect = (x, y, w, d, angle = 0) => {
  const c = Math.cos(angle * rad),
    s = Math.sin(angle * rad);
  return [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [w / 2, d / 2],
    [-w / 2, d / 2],
  ].map(([a, b]) => ({ x: x + a * c - b * s, y: y + a * s + b * c }));
};
const shape = (f) => rect(f.x, f.y, f.w, f.d, f.rot || 0);
function bounds(polygon) {
  const xs = polygon.map((p) => p.x),
    ys = polygon.map((p) => p.y);
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
}
const intersects = (a, b) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
function overlap(a, b) {
  let depth = Infinity;
  for (const poly of [a, b])
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i],
        q = poly[(i + 1) % poly.length],
        len = Math.hypot(q.x - p.x, q.y - p.y);
      if (!len) continue;
      const nx = -(q.y - p.y) / len,
        ny = (q.x - p.x) / len;
      const aa = a.map((v) => v.x * nx + v.y * ny),
        bb = b.map((v) => v.x * nx + v.y * ny);
      const d =
        Math.min(Math.max(...aa), Math.max(...bb)) -
        Math.max(Math.min(...aa), Math.min(...bb));
      if (d <= 0) return 0;
      depth = Math.min(depth, d);
    }
  return depth;
}
function wallsFor(plan) {
  const nodes = new Map(plan.nodes.map((n) => [n.id, n]));
  return plan.walls.filter(active).map((w) => {
    const a = nodes.get(w.a),
      b = nodes.get(w.b),
      len = Math.hypot(b.x - a.x, b.y - a.y);
    return {
      ...w,
      a,
      b,
      len,
      ux: (b.x - a.x) / len,
      uy: (b.y - a.y) / len,
      ops: plan.openings.filter((o) => o.wall === w.id),
    };
  });
}
function at(w, along, normal = 0) {
  return {
    x: w.a.x + w.ux * along - w.uy * normal,
    y: w.a.y + w.uy * along + w.ux * normal,
  };
}
function strip(w, from, to, n0, n1) {
  return [at(w, from, n0), at(w, to, n0), at(w, to, n1), at(w, from, n1)];
}
function wallSolids(w, bottom, top) {
  let spans = [[0, w.len]];
  for (const o of w.ops)
    if (bottom >= (o.sill || 0) - 5 && top <= (o.head || 2100) + 5) {
      const start = o.pos - o.width / 2,
        end = o.pos + o.width / 2;
      spans = spans.flatMap(([a, b]) =>
        end <= a || start >= b
          ? [[a, b]]
          : [
              [a, Math.max(a, start)],
              [Math.min(b, end), b],
            ].filter(([x, y]) => y - x > 1),
      );
    }
  return spans.map(([a, b]) => strip(w, a, b, -w.t / 2, w.t / 2));
}
const floorStanding = (f) =>
  /(?:bed|sofa|chair|table|desk)$|^(?:wardrobe|bookshelf|shoeCabinet|washer|dryer|fridge|freezer|toilet|freeTub)$/i.test(
    f.type || f.key,
  ) ||
  (f.type === "cabinet" && f.cab?.kind !== "wall");
const floorObject = (f) =>
  ((f.z || 0) < 300 || floorStanding(f)) &&
  f.h > 200 &&
  !/rug|curtain|sheer|floorHeat|stair|^free$|riser|louver|lawn|tree|outdoor|fence|gate|ceil|lamp|light/i.test(
    f.type || f.key,
  );
const passageHeight = 2000;
const passageRadius = 300;
const occupiesPassage = (f, head = passageHeight) =>
  (f.z ?? 0) < head &&
  (f.z ?? 0) + f.h > 30 &&
  !/^(?:rug|rugRound|yogaMat|floorHeat|curtain|sheer|lawn|stair.*)$/i.test(
    f.type || f.key,
  );
const storage = (f) =>
  f.h >= 1400 &&
  (["wardrobe", "bookshelf", "shoeCabinet"].includes(f.type) ||
    (f.type === "cabinet" && f.cab?.kind !== "wall"));
const nesting = (a, b) =>
  (/chair|stool|bench/i.test(a.type) && /table|desk|counter/i.test(b.type)) ||
  (/chair|stool|bench/i.test(b.type) && /table|desk|counter/i.test(a.type));
const windowlessUse = (name) =>
  /储|衣帽|设备|过道|走廊|玄关|卫|浴|storage|closet|utility|bath|corridor/i.test(
    name,
  );

function labelAreas(cells, cols) {
  const areas = [],
    queue = new Int32Array(cells.length);
  for (let first = 0; first < cells.length; first++) {
    if (cells[first] !== 0) continue;
    const area = { id: areas.length + 1, first, count: 0, outside: false };
    let head = 0,
      tail = 0;
    const visit = (i) => {
      if (cells[i] === 0) {
        cells[i] = area.id;
        queue[tail++] = i;
      }
    };
    visit(first);
    while (head < tail) {
      const i = queue[head++],
        x = i % cols;
      area.count++;
      if (x === 0 || x === cols - 1 || i < cols || i >= cells.length - cols)
        area.outside = true;
      if (x > 0) visit(i - 1);
      if (x < cols - 1) visit(i + 1);
      if (i >= cols) visit(i - cols);
      if (i + cols < cells.length) visit(i + cols);
    }
    areas.push(area);
  }
  return areas;
}

// Flood-fill a bounded raster of wall solids (openings remain room boundaries).
// Doors then connect these room regions. Cell size is bounded; precision issues
// are reported instead of silently certifying an unresolvable plan.
function roomGraph(plan, walls) {
  if (!walls.length) return null;
  const xs = walls.flatMap((w) => [w.a.x, w.b.x]),
    ys = walls.flatMap((w) => [w.a.y, w.b.y]);
  const minX = Math.min(...xs) - 400,
    minY = Math.min(...ys) - 400;
  const width = Math.max(...xs) - minX + 400,
    height = Math.max(...ys) - minY + 400;
  const step = Math.max(75, Math.ceil(Math.sqrt((width * height) / 160000)));
  const cols = Math.ceil(width / step),
    rows = Math.ceil(height / step),
    size = cols * rows;
  const cells = new Int32Array(size);
  const point = (i) => ({
    x: minX + ((i % cols) + 0.5) * step,
    y: minY + (Math.floor(i / cols) + 0.5) * step,
  });
  for (const w of walls) {
    const pad = w.t / 2 + step * 0.55;
    const x0 = Math.max(
        0,
        Math.floor((Math.min(w.a.x, w.b.x) - pad - minX) / step),
      ),
      x1 = Math.min(
        cols - 1,
        Math.ceil((Math.max(w.a.x, w.b.x) + pad - minX) / step),
      );
    const y0 = Math.max(
        0,
        Math.floor((Math.min(w.a.y, w.b.y) - pad - minY) / step),
      ),
      y1 = Math.min(
        rows - 1,
        Math.ceil((Math.max(w.a.y, w.b.y) + pad - minY) / step),
      );
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const p = point(y * cols + x),
          dx = p.x - w.a.x,
          dy = p.y - w.a.y,
          t = dx * w.ux + dy * w.uy,
          n = -dx * w.uy + dy * w.ux;
        if (t >= -step * 0.55 && t <= w.len + step * 0.55 && Math.abs(n) <= pad)
          cells[y * cols + x] = -1;
      }
  }
  const regions = labelAreas(cells, cols).map((area) => ({
    ...area,
    labels: [],
    doors: [],
    windows: [],
  }));
  const lookup = (p) => {
    const x = Math.floor((p.x - minX) / step),
      y = Math.floor((p.y - minY) / step);
    return x < 0 || y < 0 || x >= cols || y >= rows ? 0 : cells[y * cols + x];
  };
  const regionAt = (p) => regions[lookup(p) - 1];
  for (const label of plan.rooms) regionAt(label)?.labels.push(label);
  const links = [];
  for (const w of walls)
    for (const o of w.ops) {
      const a = regionAt(at(w, o.pos, w.t / 2 + step * 2)),
        b = regionAt(at(w, o.pos, -w.t / 2 - step * 2));
      if (!a || !b || a === b) continue;
      if (walkOpening(o)) {
        a.doors.push(o.id);
        b.doors.push(o.id);
        links.push([a.id, b.id, o.id]);
      } else if (isWindow(o)) {
        if (b.outside) a.windows.push(o.id);
        if (a.outside) b.windows.push(o.id);
      }
    }
  return {
    regions,
    links,
    lookup,
    regionAt,
    step,
    cells,
    cols,
    rows,
    minX,
    minY,
  };
}

// Compare walkable components in the same room with and without furniture.
// Leave small gaps behind furniture and divisions intrinsic to the shell alone.
function passageCuts(graph, walls, plan, blockers) {
  const result = new Map();
  if (!blockers.length || !graph.regions.some((r) => !r.outside)) return result;
  const { cells, cols, rows, step, minX, minY } = graph;
  // A path on the boundary can run between cell centres. Allow the maximum
  // centre offset so a coarse raster does not condemn a physically open route.
  const radius = Math.max(0, passageRadius - step / Math.SQRT2);
  const bare = cells.map((id) =>
    id > 0 && !graph.regions[id - 1].outside ? 0 : -1,
  );
  function block(grid, cx, cy, halfWidth, halfDepth, cos, sin) {
    const dx = Math.abs(cos) * halfWidth + Math.abs(sin) * halfDepth + radius;
    const dy = Math.abs(sin) * halfWidth + Math.abs(cos) * halfDepth + radius;
    const x0 = Math.max(0, Math.floor((cx - dx - minX) / step)),
      x1 = Math.min(cols - 1, Math.floor((cx + dx - minX) / step));
    const y0 = Math.max(0, Math.floor((cy - dy - minY) / step)),
      y1 = Math.min(rows - 1, Math.floor((cy + dy - minY) / step));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * cols + x;
        if (grid[i] !== 0) continue;
        const px = minX + (x + 0.5) * step - cx,
          py = minY + (y + 0.5) * step - cy;
        const a = Math.max(0, Math.abs(px * cos + py * sin) - halfWidth);
        const b = Math.max(0, Math.abs(-px * sin + py * cos) - halfDepth);
        if (a * a + b * b <= radius ** 2) grid[i] = -1;
      }
    }
  }
  const blockObject = (grid, f) => {
    const angle = (f.rot || 0) * rad;
    block(grid, f.x, f.y, f.w / 2, f.d / 2, Math.cos(angle), Math.sin(angle));
  };
  for (const w of walls)
    block(
      bare,
      (w.a.x + w.b.x) / 2,
      (w.a.y + w.b.y) / 2,
      w.len / 2,
      w.t / 2,
      w.ux,
      w.uy,
    );
  for (const s of plan.structs || [])
    if (["column", "shaft", "flue"].includes(s.kind)) blockObject(bare, s);
  for (const v of plan.voids || [])
    if (!v.depth || v.shaft)
      block(bare, v.x + v.w / 2, v.y + v.h / 2, v.w / 2, v.h / 2, 1, 0);
  const furnished = bare.slice();
  labelAreas(bare, cols);
  for (const f of blockers) blockObject(furnished, f);
  const reached = new Set();
  for (const area of labelAreas(furnished, cols)) {
    const areaMm2 = area.count * step ** 2;
    if (areaMm2 < 1_000_000) continue;
    const baseId = bare[area.first];
    if (reached.has(baseId)) {
      const roomId = cells[area.first];
      result.set(roomId, (result.get(roomId) ?? 0) + 1);
    }
    reached.add(baseId);
  }
  return result;
}

export function designFindings(plan, preferences = {}) {
  const prefs = { ...defaultDesignPreferences, ...preferences },
    walls = wallsFor(plan),
    issues = [];
  const add = (rule, ids, msg, metric = 1, level = "error") =>
    issues.push({
      rule,
      level,
      type: "设计检查",
      msg,
      targets: ids.map((id) => ({ id })),
      key: rule + ":" + [...ids].sort().join(","),
      metric,
    });
  for (const w of walls)
    for (const o of w.ops) {
      const max = { door: 1200, unequal: 1800, double: 2400 }[o.type];
      if (max && o.width > max)
        add(
          "door-size",
          [o.id],
          `普通${o.type === "door" ? "单扇" : "平开"}门宽 ${Math.round(o.width)} mm，超出当前门型的常用建模范围。请核对尺寸；大开口应采用实际的多扇推拉或折叠门。`,
          o.width,
        );
    }
  for (const w of walls)
    for (let i = 0; i < w.ops.length; i++)
      for (let j = i + 1; j < w.ops.length; j++) {
        const a = w.ops[i],
          b = w.ops[j],
          d = (a.width + b.width) / 2 - Math.abs(a.pos - b.pos);
        if (
          d > 20 &&
          Math.min(a.head || 2100, b.head || 2100) >
            Math.max(a.sill || 0, b.sill || 0)
        )
          add(
            "opening-overlap",
            [a.id, b.id],
            "同一墙段上的门窗洞口发生重叠，请核对位置与宽度。",
            d,
          );
      }
  const furniture = plan.furniture,
    polys = new Map(furniture.map((f) => [f.id, shape(f)]));
  const furnitureBounds = new Map(
    furniture.map((f) => [f.id, bounds(polys.get(f.id))]),
  );
  const wallBounds = new Map(
    walls.map((w) => [w.id, bounds(strip(w, 0, w.len, -w.t / 2, w.t / 2))]),
  );
  const structures = (plan.structs || [])
    .filter((s) => ["column", "shaft", "flue"].includes(s.kind) && s.w && s.d)
    .map((s) => {
      const poly = shape(s);
      return { poly, bounds: bounds(poly) };
    });
  for (const f of furniture) {
    if (
      ["washer", "dryer", "fridge", "toilet"].includes(f.type) &&
      Math.min(f.w, f.d) < 250
    )
      add(
        "equipment-size",
        [f.id],
        `${f.name}尺寸异常，不能通过缩小设备外框让它放进空间；请使用真实商品尺寸。`,
        250 - Math.min(f.w, f.d),
      );
    if (floorObject(f)) {
      const excess = (f.z ?? 0) + f.h - plan.height;
      if (excess > 20)
        add(
          "ceiling-collision",
          [f.id],
          `${f.name}顶部超出层高约 ${Math.round(excess)} mm，请核对离地高度与家具尺寸。`,
          excess,
        );
      let penetration = 0;
      const box = furnitureBounds.get(f.id);
      for (const w of walls) {
        if (!intersects(box, wallBounds.get(w.id))) continue;
        for (const p of wallSolids(w, f.z || 0, (f.z || 0) + f.h))
          penetration = Math.max(penetration, overlap(polys.get(f.id), p));
      }
      for (const s of structures)
        if (intersects(box, s.bounds))
          penetration = Math.max(penetration, overlap(polys.get(f.id), s.poly));
      if (penetration > 20)
        add(
          "wall-collision",
          [f.id],
          `${f.name}嵌入墙体或固定结构约 ${Math.round(penetration)} mm，请按墙面净空间重新放置。`,
          penetration,
        );
    }
    if (storage(f) && !prefs.allowFreestandingStorage) {
      const angle = (f.rot || 0) * rad,
        back = { x: Math.sin(angle), y: -Math.cos(angle) };
      const samples = [-0.35, 0, 0.35].map((t) => ({
        x: f.x + (back.x * f.d) / 2 + Math.cos(angle) * f.w * t,
        y: f.y + (back.y * f.d) / 2 + Math.sin(angle) * f.w * t,
      }));
      const support = samples.every((p) =>
        walls.some((w) => {
          const dx = p.x - w.a.x,
            dy = p.y - w.a.y,
            t = dx * w.ux + dy * w.uy,
            n = -dx * w.uy + dy * w.ux;
          return (
            t >= -20 &&
            t <= w.len + 20 &&
            Math.abs(n) <= w.t / 2 + 200 &&
            Math.abs(back.x * w.ux + back.y * w.uy) < 0.15 &&
            !w.ops.some(
              (o) =>
                t > o.pos - o.width / 2 &&
                t < o.pos + o.width / 2 &&
                (f.z || 0) + f.h > (o.sill || 0) &&
                (f.z || 0) < (o.head || 2100),
            )
          );
        }),
      );
      if (!support)
        add(
          "storage-support",
          [f.id],
          `${f.name}背面没有合适的连续墙面。普通高柜请靠墙、避开门窗；若确实作为独立隔断柜，请先开启“允许独立高柜”。`,
        );
    }
  }
  const solids = furniture
    .filter(floorObject)
    .sort(
      (a, b) => furnitureBounds.get(a.id).left - furnitureBounds.get(b.id).left,
    );
  const blockers = furniture.filter((f) => occupiesPassage(f));
  for (let i = 0; i < solids.length; i++)
    for (let j = i + 1; j < solids.length; j++) {
      const a = solids[i],
        b = solids[j];
      const aBox = furnitureBounds.get(a.id),
        bBox = furnitureBounds.get(b.id);
      if (bBox.left >= aBox.right) break;
      if (!intersects(aBox, bBox)) continue;
      if (
        nesting(a, b) ||
        (a.z || 0) >= (b.z || 0) + b.h ||
        (b.z || 0) >= (a.z || 0) + a.h
      )
        continue;
      const d = overlap(polys.get(a.id), polys.get(b.id));
      if (d > 25)
        add(
          "furniture-collision",
          [a.id, b.id],
          `${a.name}与${b.name}重叠约 ${Math.round(d)} mm，请调整位置。`,
          d,
        );
    }
  for (const w of walls)
    for (const o of w.ops)
      if (walkOpening(o)) {
        const start = o.pos - o.width / 2,
          end = o.pos + o.width / 2;
        const approach = strip(
          w,
          start + 30,
          end - 30,
          -w.t / 2 - 600,
          w.t / 2 + 600,
        );
        const swing = [];
        if (["door", "double", "unequal"].includes(o.type)) {
          const split = o.type === "unequal" ? (o.hinge ? 1 / 3 : 2 / 3) : 0.5;
          const leaves =
            o.type === "door"
              ? [[o.hinge ? end : start, o.hinge ? -1 : 1, o.width]]
              : [
                  [start, 1, o.width * split],
                  [end, -1, o.width * (1 - split)],
                ];
          for (const [pivot, direction, length] of leaves) {
            const p = at(w, pivot);
            swing.push([
              p,
              ...Array.from({ length: 13 }, (_, i) => {
                const a = ((i / 12) * Math.PI) / 2;
                return at(
                  w,
                  pivot + direction * length * Math.cos(a),
                  (o.side === -1 ? -1 : 1) * length * Math.sin(a),
                );
              }),
            ]);
          }
        }
        for (const f of furniture) {
          const poly = polys.get(f.id);
          let d = occupiesPassage(f) ? overlap(approach, poly) : 0;
          if (
            occupiesPassage(f, o.head ?? 2100) &&
            (f.z ?? 0) + f.h > (o.sill ?? 0)
          )
            for (const sector of swing) d = Math.max(d, overlap(sector, poly));
          if (d > 35)
            add(
              "door-blocked",
              [o.id, f.id],
              `${f.name}占用了门扇活动区或门口通路，请移开并保留进出空间。`,
              d,
            );
        }
      }
  const graph = roomGraph(plan, walls);
  if (graph) {
    const cuts = passageCuts(graph, walls, plan, blockers);
    if (graph.regions.some((r) => !r.outside))
      for (const f of solids) {
        const r = graph.regionAt(f);
        if (!r || r.outside)
          add(
            "outside-room",
            [f.id],
            `${f.name}不在室内有效空间中，请放回房间内。`,
          );
      }
    for (const r of graph.regions.filter(
      (r) => !r.outside && r.count * graph.step ** 2 > 250000,
    )) {
      const labels = r.labels.map((x) => x.name),
        ids = r.labels.map((x) => x.id),
        near = walls
          .filter((w) =>
            [1, -1].some(
              (s) =>
                graph.lookup(
                  at(w, w.len / 2, s * (w.t / 2 + graph.step * 2)),
                ) === r.id,
            ),
          )
          .map((w) => w.id);
      const identity = ids.length ? ids : near;
      if (cuts.has(r.id))
        add(
          "passage-blocked",
          identity,
          `${labels.join(" / ") || "室内"}的家具切断了两片可活动区域之间的通路，请移开或转动家具，保留约 ${2 * passageRadius} mm 的连续净宽。`,
          cuts.get(r.id),
        );
      if (!r.doors.length)
        add(
          "room-no-access",
          identity,
          `${labels.join(" / ") || "新增封闭空间"}没有可用出入口，不能围成无法进入的小房间。`,
        );
      if (!r.labels.length)
        add(
          "room-no-purpose",
          identity,
          "封闭区域没有标明用途。新增隔间必须说明用途、设置入口，并检查对客厅和动线的影响。",
        );
      else if (labels.some((n) => !windowlessUse(n)) && !r.windows.length)
        add(
          "room-daylight",
          identity,
          `${labels.join(" / ")}没有连接室外的窗，无法核实采光和通风。请保留开敞布局或调整分隔；不能把它当作已解决的居住空间。`,
        );
    }
    // Labelled rooms must remain connected through doors to an entrance when
    // one is present. Unspecified entrances are not invented.
    const reachable = new Set(
      graph.regions.filter((r) => r.outside).map((r) => r.id),
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const [a, b] of graph.links)
        if (reachable.has(a) !== reachable.has(b)) {
          reachable.add(a);
          reachable.add(b);
          changed = true;
        }
    }
    const hasEntry = graph.links.some(
      ([a, b]) => graph.regions[a - 1].outside !== graph.regions[b - 1].outside,
    );
    if (hasEntry)
      for (const r of graph.regions)
        if (!r.outside && r.labels.length && !reachable.has(r.id))
          add(
            "room-disconnected",
            r.labels.map((x) => x.id),
            `${r.labels.map((x) => x.name).join(" / ")}没有连通入户的出入路径，请检查隔墙和门洞。`,
          );
  }
  return issues;
}

// Adding a partition at a T-junction can split a protected wall into several
// records. Compare the physical wall and its openings in world coordinates.
function changedProtectedWalls(before, after) {
  const next = wallsFor(after);
  const nextById = new Map(next.map((w) => [w.id, w]));
  const close = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 0.5;
  const changed = [];
  for (const original of wallsFor(before)) {
    const structure = wallStructure(original);
    if (structure === "partition") continue;
    const matches = (w) =>
      w.t === original.t &&
      wallStructure(w) === structure &&
      w.status === original.status;
    const first = nextById.get(original.id);
    if (!first || !matches(first) || !close(first.a, original.a)) {
      changed.push(original.id);
      continue;
    }
    let parts = [first];
    if (!close(first.b, original.b)) {
      const along = (p) =>
        (p.x - original.a.x) * original.ux + (p.y - original.a.y) * original.uy;
      const onSegment = (p) => {
        const t = along(p);
        return (
          t >= -0.5 && t <= original.len + 0.5 && close(at(original, t), p)
        );
      };
      parts = next
        .filter(
          (w) =>
            matches(w) &&
            onSegment(w.a) &&
            onSegment(w.b) &&
            along(w.b) > along(w.a),
        )
        .sort((a, b) => along(a.a) - along(b.a));
      if (
        parts[0] !== first ||
        !close(parts.at(-1).b, original.b) ||
        parts.some((w, i) => i && !close(w.a, parts[i - 1].b))
      ) {
        changed.push(original.id);
        continue;
      }
    }
    const openings = new Map(
      parts.flatMap((w) =>
        w.ops.map((o) => [o.id, { o, center: at(w, o.pos) }]),
      ),
    );
    if (
      openings.size !== original.ops.length ||
      original.ops.some((o) => {
        const saved = openings.get(o.id);
        return (
          !saved ||
          !close(saved.center, at(original, o.pos)) ||
          ["type", "width", "sill", "head", "side", "hinge"].some(
            (k) => o[k] !== saved.o[k],
          )
        );
      })
    )
      changed.push(original.id);
  }
  return changed;
}

// Each action opts in to a rule. A new finding is advisory by default.
const layoutRules = new Set([
  "door-size",
  "opening-overlap",
  "equipment-size",
  "ceiling-collision",
  "wall-collision",
  "storage-support",
  "furniture-collision",
  "door-blocked",
  "outside-room",
  "passage-blocked",
]);
const roomRules = new Set([
  "room-no-access",
  "room-no-purpose",
  "room-daylight",
  "room-disconnected",
]);
export function ruleAppliesTo(rule, action) {
  if (action === "retryLayout") return layoutRules.has(rule);
  if (action === "reviewAiEdit")
    return layoutRules.has(rule) || roomRules.has(rule);
  return false;
}
const nativeRules = {
  嵌入墙体: "wall-collision",
  家具重叠: "furniture-collision",
  门被挡住: "door-blocked",
  推拉门被挡: "door-blocked",
  洞口重叠: "opening-overlap",
  位置异常: "outside-room",
};
export function mergeDesignFindings(design, native) {
  const key = (rule, issue) =>
    rule +
    ":" +
    (issue.targets ?? [])
      .map((t) => t.id)
      .sort()
      .join(",");
  const known = new Set(design.map((i) => key(i.rule, i)));
  return [
    ...design,
    ...native.filter(
      (i) => !nativeRules[i.type] || !known.has(key(nativeRules[i.type], i)),
    ),
  ];
}
export function reviewDesign(before, after, preferences = {}) {
  const prefs = { ...defaultDesignPreferences, ...preferences };
  const initial = designFindings(before, prefs),
    next = designFindings(after, prefs),
    old = new Map(initial.map((i) => [i.key, i]));
  const issues = next.filter(
    (i) =>
      ruleAppliesTo(i.rule, "reviewAiEdit") &&
      (!old.has(i.key) ||
        i.metric >
          old.get(i.key).metric + (i.rule === "passage-blocked" ? 0 : 10)),
  );
  const geometryChanged = ["nodes", "walls", "openings"].some(
    (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
  );
  if (geometryChanged && prefs.layoutLocked)
    issues.unshift({
      rule: "layout-locked",
      level: "error",
      key: "layout-locked",
      metric: 1,
      targets: [],
      msg: "当前已固定户型，AI 不能改墙体或门窗。若本次确实要改造，请先关闭“固定户型”，再提出需求。",
    });
  else if (geometryChanged) {
    const protectedIds = changedProtectedWalls(before, after);
    if (protectedIds.length)
      issues.unshift({
        rule: "protected-structure",
        level: "error",
        key: "protected-structure",
        metric: 1,
        targets: protectedIds.map((id) => ({ id })),
        msg: "此次修改改变了承重墙或承重待核实的墙及其门窗，请保留原结构并核实现场资料。",
      });
  }
  return {
    ok: issues.length === 0,
    issues,
    existing: initial.length,
    checked: next.length,
  };
}
export function requireDesignReview(before, after, preferences) {
  const result = reviewDesign(before, after, preferences);
  if (!result.ok) {
    const error = new Error(
      "试改未通过，原方案未改动：\n" +
        result.issues
          .slice(0, 10)
          .map((i) => i.msg)
          .join("\n"),
    );
    error.issues = result.issues;
    throw error;
  }
  return result;
}
