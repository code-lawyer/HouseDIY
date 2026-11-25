import test from "node:test";
import assert from "node:assert/strict";
import { recognition } from "./mock-provider.mjs";
import {
  demoPlan,
  applyOperations,
  fromRecognition,
  validatePlan,
  revision,
  normalizeWalls,
} from "../src/model.mjs";
import { recognize } from "../src/ai.mjs";
import { wallStructure } from "../src/design-rules.mjs";

test("furniture edits preserve original plan, IDs and unrelated geometry", () => {
  const p = demoPlan(),
    before = JSON.stringify(p),
    f = p.furniture[0];
  const r = applyOperations(p, [
    { op: "update_furniture", id: f.id, x: 4100, color: "#ccbb99" },
  ]);
  assert.equal(JSON.stringify(p), before);
  assert.equal(r.plan.furniture[0].id, f.id);
  assert.equal(r.plan.furniture[0].x, 4100);
  assert.deepEqual(r.plan.walls, p.walls);
  assert.equal(r.structural, false);
});
test("new furniture uses actual catalog options", () => {
  const p = demoPlan();
  const r = applyOperations(p, [
    { op: "add_furniture", key: "bed18", x: 2000, y: 2000 },
  ]);
  assert.equal(r.plan.furniture.length, p.furniture.length + 1);
  assert.equal(r.plan.furniture.at(-1).key, "bed18");
  assert.ok(r.plan.furniture.at(-1).w > 1000);
});
test("invalid batch is atomic", () => {
  const p = demoPlan(),
    before = revision(p);
  assert.throws(() =>
    applyOperations(p, [
      { op: "remove_furniture", id: p.furniture[0].id },
      { op: "add_furniture", key: "nonexistent", x: 2, y: 2 },
    ]),
  );
  assert.equal(revision(p), before);
});
test("bearing walls and their shared endpoints cannot be changed by AI", () => {
  const p = demoPlan(),
    wall = p.walls[0];
  for (const op of [
    { op: "remove_wall", id: wall.id },
    { op: "update_wall", id: wall.id, t: 100 },
    { op: "add_opening", wallId: wall.id, pos: 2000, width: 800 },
  ])
    assert.throws(() => applyOperations(p, [op]), /承重/);
  p.nodes.push({ id: "newnode", x: 3000, y: 2000 });
  p.walls.push({
    id: "partition",
    a: wall.a,
    b: "newnode",
    bearing: false,
    t: 100,
    status: "existing",
  });
  assert.throws(
    () =>
      applyOperations(p, [
        { op: "update_wall", id: "partition", a: [100, 100] },
      ]),
    /承重/,
  );
});
test("partition changes require confirmation and split intersections", () => {
  const p = demoPlan();
  const r = applyOperations(p, [
    { op: "add_wall", a: [200, 2000], b: [5800, 2000], t: 100 },
  ]);
  assert.equal(r.structural, true);
  assert.ok(r.plan.walls.length > p.walls.length + 1);
  assert.ok(r.warnings.length);
  validatePlan(r.plan);
});
test("openings cannot exceed wall segment", () => {
  const p = demoPlan();
  p.openings[0].pos = 0;
  assert.throws(() => validatePlan(p), /门窗超出/);
});
test("wall splitting preserves opening position in world coordinates", () => {
  const p = demoPlan(),
    w = p.walls[0];
  p.nodes.push({ id: "t1", x: 1000, y: 200 }, { id: "t2", x: 1000, y: 1500 });
  p.walls.push({ id: "cross", a: "t1", b: "t2", t: 100, bearing: false });
  normalizeWalls(p);
  const o = p.openings[0],
    owner = p.walls.find((w) => w.id === o.wall),
    a = p.nodes.find((n) => n.id === owner.a);
  assert.ok(Math.abs(a.x + o.pos - 3000) < 0.1);
  validatePlan(p);
});
test("recognition rejects missing geometry and unknown furniture", () => {
  assert.throws(() => fromRecognition({}, {}), /墙体/);
  assert.throws(
    () =>
      applyOperations(demoPlan(), [
        { op: "add_furniture", key: "<script>", x: 0, y: 0 },
      ]),
    /家具库/,
  );
});

test("recognition isolates malformed walls, room labels and furniture while retaining original wall indices", () => {
  const data = structuredClone(recognition);
  data.walls.unshift({ a: [5, 5], b: null });
  data.openings[0].wall = 1;
  data.rooms.push(null);
  data.schemes[0].furniture.unshift({ key: "unknown-product", at: [200, 150] });
  const result = fromRecognition(
    data,
    { width: 600, height: 450 },
    { schemeCount: 1, widthMeters: 5.6 },
  );
  const plan = result.variants[0].plan;
  assert.equal(plan.walls.length, 4);
  assert.equal(plan.openings[0].wall, plan.walls[0].id);
  assert.equal(plan.rooms.length, 1);
  assert.deepEqual(
    plan.furniture.map((f) => f.key),
    ["sofa"],
  );
  assert.ok(result.geometryIssues.length >= 2);
  assert.match(result.schemeIssues.join(" "), /1 件家具待补/);
  assert.equal(result.underlay.mmPerPx, 10);
});
test("an opening crossing a T junction is repairable and a single wall can form a partial 3D model", () => {
  const data = structuredClone(recognition);
  data.walls.push({ a: [300, 20], b: [300, 200] });
  const image = { width: 600, height: 450 };
  const { plan } = fromRecognition(data, image).variants[0];
  assert.equal(plan.walls.length, 6);
  assert.equal(plan.openings.length, 0);
  assert.deepEqual(plan.pendingOpenings[0].pixel, [300, 20]);
  assert.match(plan.pendingOpenings[0].reason, /所属墙段/);
  data.walls = data.walls.slice(0, 1);
  delete data.scale;
  const partial = fromRecognition(data, image);
  assert.equal(partial.variants[0].plan.walls.length, 1);
  assert.ok(partial.underlay.mmPerPx > 0);
});
test("a door far from its claimed wall stays marked for manual placement", () => {
  const drawing = structuredClone(recognition);
  drawing.openings[0] = {
    wall: 0,
    center: [300, 380],
    type: "door",
    width: 900,
  };
  const { plan } = fromRecognition(drawing, { width: 600, height: 450 })
    .variants[0];
  assert.equal(plan.openings.length, 0);
  assert.deepEqual(plan.pendingOpenings[0].pixel, [300, 380]);
});

test("a layout retry cannot replace already stored walls and openings", async () => {
  const first = structuredClone(recognition);
  first.schemes.length = 1;
  const second = structuredClone(recognition);
  second.walls.pop();
  second.openings = [];
  second.schemes[1].furniture[0].at[1] += 50;
  const responses = [first, second];
  const result = await recognize({
    image: { width: 600, height: 450 },
    options: { schemeCount: 2, height: 2800 },
    settings: { provider: "agent" },
    completeAgent: async () => responses.shift(),
  });
  assert.equal(responses.length, 0);
  for (const { plan } of result.variants) {
    assert.equal(plan.walls.length, 4);
    assert.equal(plan.openings.length, 1);
  }
});

test("empty and recolored copies do not count as distinct furniture layouts", () => {
  const drawing = structuredClone(recognition);
  drawing.schemes[1].furniture[0].at = [...drawing.schemes[0].furniture[0].at];
  drawing.schemes[2].furniture = [];
  const result = fromRecognition(
    drawing,
    { width: 600, height: 450 },
    { schemeCount: 3 },
  );
  assert.equal(result.generatedSchemeCount, 1);
  assert.equal(result.variants.length, 1);
});
test("known wall lines survive uncertain thickness and alternate numeric notation", () => {
  const data = structuredClone(recognition);
  data.scale.mmPerPixel = "10";
  for (const w of data.walls) {
    w.a = { x: String(w.a[0]), y: String(w.a[1]) };
    w.thickness = "未标明";
  }
  data.openings[0].wall = "0";
  data.openings[0].width = "1800";
  data.schemes[0].furniture[0].w = "2200";
  const result = fromRecognition(
    data,
    { width: 600, height: 450 },
    { schemeCount: 1 },
  );
  const p = result.variants[0].plan;
  assert.equal(p.walls.length, 4);
  assert.ok(p.walls.every((w) => w.t === 120));
  assert.match(result.assumptions.join(" "), /厚度待核对/);
  assert.equal(p.openings[0].width, 1800);
  assert.equal(p.furniture[0].w, 2200);
});
test("a retry cannot erase an unresolved door just by omitting it", async () => {
  const first = structuredClone(recognition);
  first.openings.push({
    wall: 9,
    type: "door",
    width: 900,
    center: [300, 430],
  });
  const responses = [first, recognition];
  const result = await recognize({
    image: { width: 600, height: 450 },
    options: { schemeCount: 1 },
    settings: { provider: "agent" },
    completeAgent: async () => responses.shift(),
  });
  assert.equal(result.variants[0].plan.pendingOpenings.length, 1);
});

test("user span calibrates the wall extents and underlay at each requested scheme count", () => {
  const image = { width: 600, height: 450 };
  for (const [widthMeters, schemeCount] of [
    [10, 1],
    [8, 2],
    [100, 3],
  ]) {
    const result = fromRecognition(recognition, image, {
      widthMeters,
      schemeCount,
    });
    assert.equal(result.variants.length, schemeCount);
    const underlay = result.underlay;
    assert.equal(underlay.mmPerPx, (widthMeters * 1000) / 560);
    assert.match(result.assumptions[0], /5\.6 米.*有差异/);
    for (const [index, { plan }] of result.variants.entries()) {
      const xs = plan.nodes.map((n) => n.x);
      assert.equal(Math.max(...xs) - Math.min(...xs), widthMeters * 1000);
      const world = ([x, y]) => [
        Math.round(underlay.x + x * underlay.mmPerPx),
        Math.round(underlay.y + y * underlay.mmPerPx),
      ];
      assert.deepEqual([plan.nodes[0].x, plan.nodes[0].y], world([20, 20]));
      assert.deepEqual(
        [plan.furniture[0].x, plan.furniture[0].y],
        world([420, 220 + 15 * index]),
      );
      assert.deepEqual(plan.walls, result.variants[0].plan.walls);
    }
  }
  assert.equal(
    fromRecognition(recognition, image, { schemeCount: 1 }).underlay.mmPerPx,
    10,
  );
});

test("recognition retries incomplete schemes and retains usable results if still incomplete", async () => {
  for (const problem of ["few", "same"]) {
    const wrong = structuredClone(recognition);
    wrong.schemes =
      problem === "few"
        ? wrong.schemes.slice(0, 1)
        : [wrong.schemes[0], { ...wrong.schemes[0], name: "另一名称" }];
    const prompts = [];
    const args = {
      image: { width: 600, height: 450 },
      settings: { provider: "agent" },
      options: { schemeCount: 2, height: 2800 },
      completeAgent: async (_settings, prompt) => {
        prompts.push(prompt);
        return prompts.length === 1 ? wrong : recognition;
      },
    };
    const result = await recognize(args);
    assert.equal(result.variants.length, 2);
    assert.equal(result.draftStatus, undefined);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], problem === "few" ? /只返回 1 套/ : /完全相同/);
    const draft = await recognize({
      ...args,
      completeAgent: async () => wrong,
    });
    assert.equal(draft.draftStatus, "partial");
    assert.deepEqual(
      draft.variants.map((v) => v.name),
      ["浅木"],
    );
    assert.match(draft.assumptions[0], /保留 1 套可编辑方案/);
  }
});

test("recognition preserves the walls and original image if all furniture layouts are unusable", async () => {
  const broken = structuredClone(recognition);
  broken.schemes = [{ name: "无效家具方案", furniture: [{ key: "sofa" }] }];
  const image = {
    width: 600,
    height: 450,
    dataUrl: "data:image/png;base64,AA==",
  };
  const result = await recognize({
    image,
    settings: { provider: "agent" },
    options: { schemeCount: 1, height: 2800 },
    completeAgent: async () => broken,
  });
  assert.equal(result.draftStatus, "partial");
  const [variant] = result.variants;
  assert.equal(variant.name, "户型结构草稿");
  assert.equal(variant.plan.walls.length, 4);
  assert.equal(variant.plan.openings.length, 1);
  assert.deepEqual(variant.plan.furniture, []);
  assert.equal(result.underlay.src, image.dataUrl);
  assert.match(result.assumptions[1], /第 1 套方案无法建模/);
});

test("a failed retry keeps the first usable recognition while a cancelled retry stops", async () => {
  const incomplete = {
    ...recognition,
    schemes: recognition.schemes.slice(0, 1),
  };
  const args = {
    image: { width: 600, height: 450 },
    settings: { provider: "agent" },
    options: { schemeCount: 2, height: 2800 },
  };
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    let requests = 0;
    const request = recognize({
      ...args,
      signal: controller.signal,
      completeAgent: async () => {
        if (++requests === 1) return incomplete;
        if (cancel) controller.abort();
        throw new Error("模型响应超时");
      },
    });
    if (cancel) await assert.rejects(request, { name: "AbortError" });
    else {
      const draft = await request;
      assert.equal(draft.draftStatus, "partial");
      assert.equal(draft.variants[0].plan.furniture[0].key, "sofa");
    }
    assert.equal(requests, 2);
  }
});

test("unknown and inferred walls stay protected across structural operations and shared endpoints", () => {
  const p = demoPlan();
  const wall = p.walls.find((w) => w.id === p.openings[0].wall);
  const opening = p.openings[0];
  delete wall.bearing;
  p.nodes.push({ id: "tip", x: 2000, y: 2000 });
  p.walls.push({
    id: "partition",
    a: wall.a,
    b: "tip",
    t: 100,
    bearing: false,
    status: "existing",
  });
  for (const bearing of [undefined, null, false]) {
    if (bearing !== undefined) wall.bearing = bearing;
    assert.equal(wallStructure(wall), "unknown");
    for (const op of [
      { op: "remove_wall", id: wall.id },
      { op: "update_wall", id: wall.id, t: 100 },
      { op: "add_opening", wallId: wall.id, pos: 2500 },
      { op: "remove_opening", id: opening.id },
      { op: "update_opening", id: opening.id, width: 900 },
      { op: "update_wall", id: "partition", a: [300, 300] },
    ])
      assert.throws(() => applyOperations(p, [op]), /承重/);
  }
  const image = structuredClone(recognition);
  delete image.walls[0].bearing;
  assert.equal(
    wallStructure(
      fromRecognition(image, { width: 600, height: 450 }).variants[0].plan
        .walls[0],
    ),
    "unknown",
  );
  assert.equal(
    wallStructure({ bearing: false, status: "new", bearingFrom: "inferred" }),
    "partition",
  );
  assert.equal(wallStructure({ bearing: false }), "partition");
  assert.equal(wallStructure({ bearing: true, status: "new" }), "bearing");
});

test("renderer fixture kinds and geometry are checked before persistence, with legacy dimension defaults", () => {
  const p = demoPlan();
  p.elec = [{ id: "socket1", kind: "socket", x: 250, y: 300, links: [] }];
  p.structs = [{ id: "s1", kind: "shaft", x: 800, y: 200 }];
  p.beams = [{ id: "b1", a: { x: 400, y: 400 }, b: { x: 2000, y: 400 } }];
  p.measures = [{ id: "m1", a: { x: 400, y: 400 }, b: { x: 2000, y: 400 } }];
  p.voids = [{ id: "v1", x: 800, y: 400, w: 80, h: 100 }];
  p.comments = [{ id: "c1", x: 500, y: 500, text: "确认点位" }];
  const valid = validatePlan(p);
  assert.equal(valid.elec[0].h, 300);
  assert.equal(valid.structs[0].w, 600);
  assert.equal(valid.structs[0].rot, 0);
  assert.equal(valid.beams[0].depth, 400);
  assert.deepEqual(valid.comments[0].replies, []);
  for (const [key, field, value] of [
    ["elec", "kind", "unavailable"],
    ["elec", "links", 42],
    ["structs", "kind", "unavailable"],
    ["beams", "a", null],
    ["measures", "b", { x: 22 }],
    ["voids", "w", 0],
    ["comments", "replies", {}],
  ]) {
    const bad = structuredClone(p);
    bad[key][0][field] = value;
    assert.throws(
      () => validatePlan(bad),
      (e) => e.message.includes(key + "[" + bad[key][0].id + "]." + field),
    );
  }
  assert.equal(p.structs[0].w, undefined);
});
test("invalid numbers and duplicate IDs are rejected", () => {
  const p = demoPlan();
  p.furniture[0].x = Infinity;
  assert.throws(() => validatePlan(p));
  const p2 = demoPlan();
  p2.furniture[0].id = p2.nodes[0].id;
  assert.throws(() => validatePlan(p2), /重复/);
});

test("AI demolition uses the renderer status and removed walls do not split active walls", () => {
  const p = demoPlan();
  p.nodes.push({ id: "p1", x: 200, y: 2000 }, { id: "p2", x: 5800, y: 2000 });
  p.walls.push({
    id: "partition",
    a: "p1",
    b: "p2",
    t: 100,
    bearing: false,
    status: "existing",
  });
  const result = applyOperations(p, [{ op: "remove_wall", id: "partition" }]);
  assert.equal(
    result.plan.walls.find((w) => w.id === "partition").status,
    "removed",
  );
  assert.equal(result.plan.walls.length, 5);
  assert.equal(p.walls.at(-1).status, "existing");
  p.walls.at(-1).status = "removed";
  normalizeWalls(p);
  assert.equal(p.walls.length, 5);
});

test("door handing works through both providers and unsupported fields fail atomically", async () => {
  const { chatSchema } = await import("../src/schemas.mjs");
  const { tools } = await import("../src/ai.mjs");
  const api = tools.find((t) => t.function.name === "propose_changes").function
    .parameters.properties.operations.items;
  for (const schema of [chatSchema.properties.operations.items, api]) {
    for (const op of ["add_opening", "update_opening"]) {
      const fields = schema.anyOf.find(
        (s) => s.properties.op.enum[0] === op,
      ).properties;
      assert.ok(fields.hinge && fields.side && fields.type);
    }
  }
  const p = demoPlan();
  p.walls[1].bearing = false;
  p.walls[1].bearingFrom = "drawing";
  const added = applyOperations(p, [
    {
      op: "add_opening",
      wallId: p.walls[1].id,
      pos: 2000,
      width: 800,
      hinge: 1,
      side: -1,
      head: null,
    },
  ]);
  const door = added.plan.openings.at(-1);
  assert.equal(door.hinge, 1);
  assert.equal(door.side, -1);
  const changed = applyOperations(added.plan, [
    { op: "update_opening", id: door.id, hinge: 0, side: 1, type: "double" },
  ]);
  assert.equal(changed.plan.openings.at(-1).hinge, 0);
  assert.equal(changed.plan.openings.at(-1).type, "double");
  const original = revision(p);
  assert.throws(
    () =>
      applyOperations(p, [
        { op: "update_furniture", id: p.furniture[0].id, x: 4000, unknown: 1 },
      ]),
    /不支持字段/,
  );
  assert.throws(
    () =>
      applyOperations(p, [
        { op: "add_opening", wallId: p.walls[1].id, pos: 2000, side: 9 },
      ]),
    /取值无效/,
  );
  assert.equal(revision(p), original);
});
