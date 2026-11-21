import test from "node:test";
import assert from "node:assert/strict";
import {
  demoPlan,
  applyOperations,
  sceneContext,
  fromRecognition,
  emptyPlan,
  newFurniture,
} from "../src/model.mjs";
import {
  designFindings,
  reviewDesign,
  ruleAppliesTo,
  mergeDesignFindings,
} from "../src/design-rules.mjs";
import { proposeDesign, chat } from "../src/ai.mjs";
import { recognition } from "./mock-provider.mjs";

const empty = () => {
  const p = demoPlan();
  p.furniture = [];
  return p;
};
const rules = (p, ops, preferences = {}) =>
  reviewDesign(p, applyOperations(p, ops).plan, preferences).issues.map(
    (i) => i.rule,
  );
test("only explicitly registered rules can request another layout or reject an AI edit", () => {
  for (const action of ["retryLayout", "reviewAiEdit"])
    assert.equal(ruleAppliesTo("new-check", action), false);
  assert.equal(ruleAppliesTo("door-blocked", "reviewAiEdit"), true);
  assert.equal(ruleAppliesTo("room-no-access", "retryLayout"), false);
  assert.equal(ruleAppliesTo("wall-collision", "saveProject"), false);
});
test("a smaller existing wall clash can be saved, and matching checker results only appear once", () => {
  const p = empty();
  const f = newFurniture("counter", { x: 2000, y: 544 });
  p.furniture.push(f);
  const issues = designFindings(p);
  const wall = issues.find((i) => i.rule === "wall-collision");
  assert.equal(Math.round(wall.metric), 56);
  const move = (y) => rules(p, [{ op: "update_furniture", id: f.id, y }]);
  assert.ok(!move(565).includes("wall-collision"));
  assert.ok(move(510).includes("wall-collision"));
  const another = { type: "嵌入墙体", targets: [{ id: "other" }] };
  const nativeOnly = { type: "采光", targets: [{ id: f.id }] };
  assert.deepEqual(
    mergeDesignFindings(
      [wall],
      [{ type: "嵌入墙体", targets: [{ id: f.id }] }, another, nativeOnly],
    ),
    [wall, another, nativeOnly],
  );
});
test("normal single doors cannot occupy an entire wall; folding door type is distinct", () => {
  const p = empty();
  p.walls[2].bearing = false;
  p.walls[2].bearingFrom = "drawing";
  const op = {
    op: "add_opening",
    wallId: p.walls[2].id,
    pos: 2800,
    width: 5600,
    type: "door",
  };
  assert.ok(rules(p, [op], { layoutLocked: false }).includes("door-size"));
  assert.deepEqual(
    rules(p, [{ ...op, type: "folding" }], { layoutLocked: false }),
    [],
  );
});
test("ordinary edits keep the layout locked, including door-only changes", () => {
  const p = empty();
  p.walls[2].bearing = false;
  p.walls[2].bearingFrom = "drawing";
  assert.ok(
    rules(p, [{ op: "add_wall", a: [2000, 2000], b: [2500, 2000] }]).includes(
      "layout-locked",
    ),
  );
  assert.ok(
    rules(p, [
      { op: "add_opening", wallId: p.walls[2].id, pos: 2000, width: 900 },
    ]).includes("layout-locked"),
  );
});
const boxOps = [
  { op: "add_wall", a: [3500, 1500], b: [4900, 1500] },
  { op: "add_wall", a: [4900, 1500], b: [4900, 2900] },
  { op: "add_wall", a: [4900, 2900], b: [3500, 2900] },
  { op: "add_wall", a: [3500, 2900], b: [3500, 1500] },
];
test("closed boxes without entrances or a purpose are rejected even with layout unlocked", () => {
  const findings = rules(empty(), boxOps, { layoutLocked: false });
  assert.ok(findings.includes("room-no-access"));
  assert.ok(findings.includes("room-no-purpose"));
});
test("a windowless labelled bedroom fails; an accessible storage room is allowed", () => {
  const p = empty();
  const built = applyOperations(p, boxOps).plan;
  const w = built.walls.find((w) => w.status === "new");
  const next = applyOperations(built, [
    { op: "add_opening", wallId: w.id, pos: 700, width: 800, type: "sliding" },
    { op: "add_room", name: "客卧", x: 4200, y: 2200 },
  ]).plan;
  assert.ok(
    reviewDesign(p, next, { layoutLocked: false }).issues.some(
      (i) => i.rule === "room-daylight",
    ),
  );
  next.rooms.at(-1).name = "储物间";
  assert.deepEqual(reviewDesign(p, next, { layoutLocked: false }).issues, []);
});
test("wardrobes cannot block a hinged doorway or a sliding doorway", () => {
  for (const type of ["door", "sliding"]) {
    const p = empty();
    p.openings.find((o) => o.type === "door").type = type;
    const findings = rules(p, [
      {
        op: "add_furniture",
        key: "cabWardrobe",
        x: 650,
        y: 3400,
        w: 900,
        rot: 270,
      },
    ]);
    assert.ok(findings.includes("door-blocked"), type);
  }
});

test("door checks keep the full walking height and distinguish an unequal door's longer leaf", () => {
  const p = empty();
  const door = p.openings.find((o) => o.type === "door");
  const move = {
    op: "add_furniture",
    key: "coffeeTable",
    x: 550,
    y: 3400,
    w: 560,
    d: 380,
    h: 450,
  };
  for (const type of ["door", "sliding"]) {
    door.type = type;
    assert.ok(rules(p, [{ ...move, z: 300 }]).includes("door-blocked"));
    assert.ok(
      rules(p, [{ ...move, key: "floorLamp", z: 900 }]).includes(
        "door-blocked",
      ),
    );
    assert.ok(
      !rules(p, [{ ...move, z: 2220, h: 250 }]).includes("door-blocked"),
    );
  }
  door.type = "unequal";
  door.width = 1650;
  const besideLeaf = { ...move, x: 1130, y: 3975, w: 150, d: 150 };
  assert.ok(rules(p, [besideLeaf]).includes("door-blocked"));
  door.hinge = 1;
  assert.ok(!rules(p, [besideLeaf]).includes("door-blocked"));
});

function passagePlan(top = 1500, bottom = 2500) {
  const plan = emptyPlan("过道测试");
  const vertices = [
    [0, 0],
    [3000, 0],
    [3000, top],
    [5000, top],
    [5000, 0],
    [8000, 0],
    [8000, 4000],
    [5000, 4000],
    [5000, bottom],
    [3000, bottom],
    [3000, 4000],
    [0, 4000],
  ];
  plan.nodes = vertices.map(([x, y], i) => ({ id: "n" + i, x, y }));
  plan.walls = plan.nodes.map((n, i) => ({
    id: "w" + i,
    a: n.id,
    b: plan.nodes[(i + 1) % vertices.length].id,
    t: 120,
    bearing: true,
    status: "existing",
  }));
  plan.openings = [
    {
      id: "entry",
      wall: "w11",
      type: "door",
      pos: 2000,
      width: 900,
      sill: 0,
      head: 2100,
      hinge: 0,
      side: 1,
    },
    {
      id: "window",
      wall: "w0",
      type: "window",
      pos: 1500,
      width: 1200,
      sill: 900,
      head: 2100,
    },
  ];
  plan.rooms = [{ id: "living", name: "客厅", x: 1400, y: 2200 }];
  plan.furniture = [
    newFurniture("sofa", { x: 6450, y: 2350, w: 1600, d: 870, h: 820 }),
  ];
  return plan;
}

test("furniture that cuts a walkable interior passage is flagged, while a usable side route stays open", () => {
  const plan = passagePlan();
  const move = {
    op: "update_furniture",
    id: plan.furniture[0].id,
    x: 4000,
    y: 2000,
  };
  assert.deepEqual(designFindings(plan), []);
  assert.throws(() => proposeDesign(plan, [move]), /连续净宽/);
  const blocked = applyOperations(plan, [move]).plan;
  assert.deepEqual(
    rules(blocked, [{ op: "update_furniture", id: move.id, color: "#ccbb99" }]),
    [],
  );
  const shortened = applyOperations(blocked, [
    { op: "update_furniture", id: move.id, w: 800 },
  ]).plan;
  assert.ok(
    designFindings(shortened).some((i) => i.rule === "passage-blocked"),
  );
  assert.equal(reviewDesign(blocked, shortened).ok, true);
  assert.deepEqual(rules(plan, [{ ...move, z: 2210, h: 270 }]), []);
  const wider = passagePlan(1000, 3000);
  assert.deepEqual(
    rules(wider, [{ ...move, id: wider.furniture[0].id, y: 1550 }]),
    [],
  );
  const borderline = passagePlan(1000, 2730);
  assert.deepEqual(
    rules(borderline, [{ ...move, id: borderline.furniture[0].id, y: 1595 }]),
    [],
  );
});

test("elevating floor furniture still checks its physical volume and tall cabinets' backing", () => {
  const p = empty();
  const cabinet = {
    op: "add_furniture",
    key: "cabWardrobe",
    x: 3000,
    y: 2200,
    z: 300,
    w: 800,
  };
  assert.ok(rules(p, [cabinet]).includes("storage-support"));
  const sofa = { op: "add_furniture", key: "sofa", x: 3000, y: 2200 };
  const table = {
    op: "add_furniture",
    key: "coffeeTable",
    x: 3000,
    y: 2200,
    z: 300,
    h: 400,
  };
  assert.ok(rules(p, [sofa, table]).includes("furniture-collision"));
  assert.deepEqual(rules(p, [sofa, { ...table, z: 1100 }]), []);
  assert.ok(rules(p, [{ ...table, z: 2600 }]).includes("ceiling-collision"));
});

test("the final review protects ambiguous walls and openings while accepting a geometry-preserving split", () => {
  const plan = empty();
  const wall = plan.walls.find((w) => w.id === plan.openings[0].wall);
  const unlocked = { layoutLocked: false };
  for (const bearing of [true, null, false]) {
    wall.bearing = bearing;
    const edited = structuredClone(plan);
    edited.openings[0].width -= 100;
    assert.ok(
      reviewDesign(plan, edited, unlocked).issues.some(
        (i) => i.rule === "protected-structure",
      ),
    );
    const removed = structuredClone(plan);
    removed.walls[0].status = "removed";
    assert.ok(
      reviewDesign(plan, removed, unlocked).issues.some(
        (i) => i.rule === "protected-structure",
      ),
    );
  }
  const split = applyOperations(plan, [
    { op: "add_wall", a: [1000, 200], b: [1000, 1200], t: 100 },
  ]).plan;
  assert.ok(
    !reviewDesign(plan, split, unlocked).issues.some(
      (i) => i.rule === "protected-structure",
    ),
  );
  wall.bearingFrom = "drawing";
  const adjusted = structuredClone(plan);
  adjusted.openings[0].width -= 100;
  assert.equal(reviewDesign(plan, adjusted, unlocked).ok, true);
});
test("ordinary tall cabinets need a usable rear wall, independent storage is explicit", () => {
  const p = empty(),
    op = { op: "add_furniture", key: "cabWardrobe", x: 3000, y: 2250, w: 1200 };
  assert.ok(rules(p, [op]).includes("storage-support"));
  assert.deepEqual(rules(p, [op], { allowFreestandingStorage: true }), []);
  assert.deepEqual(rules(p, [{ ...op, x: 5400, y: 2100, rot: 90 }]), []);
  assert.ok(
    rules(p, [{ ...op, x: 3000, y: 600 }]).includes("storage-support"),
    "window cannot support the high cabinet",
  );
});
test("low freestanding furniture is allowed, collision and toy-sized appliances are not", () => {
  const p = empty();
  assert.deepEqual(
    rules(p, [{ op: "add_furniture", key: "coffeeTable", x: 3000, y: 2200 }]),
    [],
  );
  assert.ok(
    rules(p, [
      { op: "add_furniture", key: "washer", x: 3000, y: 2200, w: 80 },
    ]).includes("equipment-size"),
  );
  assert.ok(
    rules(p, [{ op: "add_furniture", key: "sofa", x: 5800, y: 2200 }]).includes(
      "wall-collision",
    ),
  );
  assert.ok(
    rules(p, [
      { op: "add_furniture", key: "sofa", x: 50000, y: 50000 },
    ]).includes("outside-room"),
  );
  assert.ok(
    rules(p, [
      { op: "add_furniture", key: "sofa", x: 3000, y: 2200 },
      { op: "add_furniture", key: "sofa", x: 3000, y: 2200 },
    ]).includes("furniture-collision"),
  );
});
test("rotated cabinets use their actual back, and chairs may tuck under a table", () => {
  const p = empty();
  assert.deepEqual(
    rules(p, [
      {
        op: "add_furniture",
        key: "cabWardrobe",
        x: 600,
        y: 1500,
        rot: 270,
        w: 1000,
      },
    ]),
    [],
  );
  assert.deepEqual(
    rules(p, [
      { op: "add_furniture", key: "diningTable", x: 3000, y: 2200 },
      { op: "add_furniture", key: "chair", x: 3000, y: 2300 },
    ]),
    [],
  );
});
test("existing warnings do not block paint changes, newly added problems do", () => {
  const p = applyOperations(empty(), [
    { op: "add_furniture", key: "cabWardrobe", x: 3000, y: 2250 },
  ]).plan;
  assert.ok(designFindings(p).length);
  assert.deepEqual(
    rules(p, [
      { op: "update_furniture", id: p.furniture[0].id, color: "#ccbb99" },
    ]),
    [],
  );
  const before = JSON.stringify(p);
  assert.throws(
    () =>
      proposeDesign(p, [
        { op: "add_furniture", key: "washer", x: 50000, y: 50000 },
      ]),
    /原方案未改动/,
  );
  assert.equal(JSON.stringify(p), before);
});
test("scene context retains site facts and recognition retains door handing", () => {
  const p = empty();
  p.comments = [{ id: "note", text: "排污口待测" }];
  p.elec = [{ id: "socket", kind: "socket", x: 700, y: 2000 }];
  p.beams = [{ id: "beam" }];
  p.structs = [{ id: "drain" }];
  const scene = sceneContext(p, {});
  for (const key of ["comments", "elec", "beams", "structs"])
    assert.deepEqual(scene[key], p[key]);
  const input = structuredClone(recognition);
  input.openings.push({
    wall: 2,
    center: [300, 430],
    type: "door",
    width: 900,
    sill: 0,
    head: 2100,
    hinge: 1,
    side: -1,
  });
  const result = fromRecognition(input, { width: 600, height: 450 });
  assert.equal(result.variants[0].plan.openings.at(-1).hinge, 1);
  assert.equal(result.variants[0].plan.openings.at(-1).side, -1);
  input.openings.at(-1).hinge = null;
  assert.ok(
    fromRecognition(input, { width: 600, height: 450 }).assumptions.some((x) =>
      x.includes("开启方向"),
    ),
  );
});

test("Codex uses the same knowledge and reviews, with a correction before a proposal", async () => {
  const plan = empty(),
    prompts = [];
  const reply = await chat({
    settings: { provider: "codex" },
    plan,
    messages: [],
    message: "安排柜子",
    assumptions: ["排污口待实测"],
    completeCodex: async (_settings, prompt) => {
      prompts.push(prompt);
      return prompts.length === 1
        ? {
            reply: "拟放一个衣柜",
            operations: [
              { op: "add_furniture", key: "cabWardrobe", x: 3000, y: 2200 },
            ],
          }
        : {
            reply: "拟靠右侧实墙摆放",
            operations: [
              {
                op: "add_furniture",
                key: "cabWardrobe",
                x: 5400,
                y: 2100,
                rot: 90,
                w: 1200,
              },
            ],
          };
    },
  });
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /装修编辑知识 v1/);
  assert.match(prompts[0], /排污口待实测/);
  assert.match(prompts[1], /背面没有合适/);
  assert.ok(reply.proposal.review.ok);
  assert.equal(plan.furniture.length, 0);
});
