import test from "node:test";
import assert from "node:assert/strict";
import {
  demoPlan,
  applyOperations,
  fromRecognition,
  validatePlan,
  revision,
  normalizeWalls,
} from "../src/model.mjs";

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
