import test from "node:test";
import assert from "node:assert/strict";
import { EditorSession } from "../public/editor-session.js";

test("a save drains edits made while its first write is in flight", async () => {
  const state = { plan: { x: 100 }, underlay: null, gesture: false };
  const writes = [];
  const session = new EditorSession(
    { id: "project-a", underlay: null },
    { id: "variant-a", plan: { x: 0 }, revision: "r0" },
    {
      readState: async () => structuredClone(state),
      status() {},
      write: async (path, body) => {
        writes.push({ path, ...body });
        if (writes.length === 1) {
          state.plan.x = 200;
          state.underlay = { x: 10 };
        }
        return {
          plan: body.plan,
          underlay: body.underlay,
          revision: "r" + writes.length,
        };
      },
    },
  );
  session.ready = true;
  const final = await session.save();
  assert.deepEqual(
    writes.map((w) => w.plan.x),
    [100, 200],
  );
  assert.ok(
    writes.every(
      (w) => w.path === "/api/projects/project-a/variants/variant-a/save",
    ),
  );
  assert.equal(writes[1].revision, "r1");
  assert.ok(!Object.hasOwn(writes[0], "underlay"));
  assert.deepEqual(writes[1].underlay, { x: 10 });
  assert.equal(writes[1].expectedUnderlayVersion, 0);
  assert.equal(final.plan.x, 200);
  assert.deepEqual(session.project.underlay, { x: 10 });
});

test("a failed save preserves the baseline and permits retry", async () => {
  let fail = true;
  const labels = [];
  const session = new EditorSession(
    { id: "a", underlay: null },
    { id: "b", plan: { x: 0 }, revision: "r0" },
    {
      readState: async () => ({ plan: { x: 1 }, underlay: null }),
      status: (text) => labels.push(text),
      write: async (_path, body) => {
        if (fail) throw new Error("disk unavailable");
        return { ...body, revision: "r1" };
      },
    },
  );
  session.ready = true;
  await assert.rejects(session.save(), /disk unavailable/);
  assert.equal(session.revision, "r0");
  assert.equal(session.baseline, '{"x":0}');
  assert.equal(labels.at(-1), "保存未完成 · 重试");
  fail = false;
  await session.save();
  assert.equal(session.revision, "r1");
  session.dispose();
  assert.equal(await session.save(), undefined);
});

test("disposing a project during a state read prevents a late write", async () => {
  const read = Promise.withResolvers();
  let writes = 0;
  const session = new EditorSession(
    { id: "p", lifecycle: 2, underlay: null },
    { id: "v", plan: { x: 0 }, revision: "r" },
    {
      readState: () => read.promise,
      status() {},
      write: async () => {
        writes++;
      },
    },
  );
  session.ready = true;
  const saving = session.save();
  session.dispose();
  read.resolve({ plan: { x: 1 }, underlay: null });
  await saving;
  assert.equal(writes, 0);
});
