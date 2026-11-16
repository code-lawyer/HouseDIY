import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { createStore, Conflict } from "../src/store.mjs";
import { applyOperations, revision } from "../src/model.mjs";
mkdirSync(resolve(".qa"), { recursive: true });
const make = (t) => {
  const dir = mkdtempSync(resolve(".qa/store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createStore(dir, {
    encrypt: async (text) => Buffer.from(text).toString("base64"),
    decrypt: async (text) => Buffer.from(text, "base64").toString(),
  });
  store.ensureDemo();
  return store;
};
test("default Codex and external API configs survive switching without leaking secrets", async (t) => {
  const store = make(t);
  assert.equal(store.publicSettings().provider, "codex");
  await store.setSettings({
    provider: "api",
    baseUrl: "https://example.com/v1",
    model: "custom",
    apiKey: "test-secret-only",
  });
  assert.equal((await store.credentials()).apiKey, "test-secret-only");
  assert.ok(
    !JSON.stringify(store.publicSettings()).includes("test-secret-only"),
  );
  assert.ok(
    !readFileSync(join(store.directory, "settings.json"), "utf8").includes(
      "test-secret-only",
    ),
  );
  await store.setSettings({ provider: "codex" });
  assert.equal((await store.credentials()).apiKey, "");
  assert.equal(store.publicSettings().model, "custom");
  await store.setSettings({ provider: "api" });
  assert.equal((await store.credentials()).apiKey, "test-secret-only");
  await store.setSettings({
    provider: "api",
    baseUrl: "https://different.example/v1",
  });
  assert.equal(store.publicSettings().hasKey, false);
});
test("revision conflict preserves manual work and stores recoverable history", (t) => {
  const store = make(t),
    p = store.get(store.list()[0].id),
    v = p.variants[0],
    changed = applyOperations(v.plan, [
      { op: "update_furniture", id: v.plan.furniture[0].id, x: 4300 },
    ]);
  const result = store.commit(p.id, v.id, v.revision, changed.plan);
  assert.notEqual(result.revision, v.revision);
  assert.throws(() => store.commit(p.id, v.id, v.revision, v.plan), Conflict);
  const after = store.get(p.id).variants[0];
  assert.equal(after.plan.furniture[0].x, 4300);
  assert.deepEqual(after.history[0].plan, v.plan);
});
test("cloned variants are independent and reopen from disk", (t) => {
  const store = make(t),
    p = store.get(store.list()[0].id),
    v = p.variants[0],
    copy = store.cloneVariant(p.id, v.id);
  const next = applyOperations(copy.plan, [
    { op: "remove_furniture", id: copy.plan.furniture[0].id },
  ]);
  store.commit(p.id, copy.id, copy.revision, next.plan);
  const reopened = createStore(store.directory).get(p.id);
  assert.equal(
    reopened.variants[0].plan.furniture.length,
    v.plan.furniture.length,
  );
  assert.equal(
    reopened.variants[1].plan.furniture.length,
    v.plan.furniture.length - 1,
  );
});
test("invalid project IDs cannot escape the project directory", (t) => {
  const store = make(t);
  assert.throws(() => store.get("../../settings"), /ID/);
});
test("image calibration persists even without a geometry revision", (t) => {
  const store = make(t),
    p = store.get(store.list()[0].id),
    v = p.variants[0];
  const underlay = {
    src: "data:image/png;base64,aGVsbG8=",
    imgW: 600,
    imgH: 450,
    mmPerPx: 12,
    x: 100,
    y: 50,
    opacity: 0.4,
    visible: true,
    locked: false,
  };
  store.commit(p.id, v.id, v.revision, v.plan, "校准原图", underlay);
  assert.deepEqual(store.get(p.id).underlay, underlay);
  assert.equal(store.get(p.id).variants[0].revision, v.revision);
  assert.throws(
    () =>
      store.commit(p.id, v.id, v.revision, v.plan, "校准", {
        ...underlay,
        src: "javascript:alert(1)",
      }),
    /格式/,
  );
});

test("legacy demolition plans and history reopen with consistent revisions", (t) => {
  const store = make(t),
    p = store.get(store.list()[0].id),
    v = p.variants[0];
  v.plan.walls[0].status = "demolish";
  v.revision = revision(v.plan);
  v.history.push({ plan: structuredClone(v.plan), revision: v.revision });
  store.save(p);
  const reopened = store.get(p.id),
    fixed = reopened.variants[0];
  assert.equal(fixed.plan.walls[0].status, "removed");
  assert.equal(fixed.revision, revision(fixed.plan));
  assert.equal(fixed.history[0].plan.walls[0].status, "removed");
  assert.equal(fixed.history[0].revision, revision(fixed.history[0].plan));
  assert.equal(reopened.updatedAt, p.updatedAt);
  assert.ok(
    readFileSync(
      join(store.directory, "projects", p.id + ".json"),
      "utf8",
    ).includes('"demolish"'),
  );
  store.commit(p.id, fixed.id, fixed.revision, fixed.plan, "保存", null);
  assert.ok(
    !readFileSync(
      join(store.directory, "projects", p.id + ".json"),
      "utf8",
    ).includes('"demolish"'),
  );
});
