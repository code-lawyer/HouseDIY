import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
test("unreadable project records stay intact and do not block a legacy workspace on restart", (t) => {
  const store = make(t),
    project = store.list()[0];
  const directory = join(store.directory, "projects");
  const damaged = {
    "1111111111111111.json": '{"name":',
    "2222222222222222.json": "null",
    "3333333333333333.json": JSON.stringify({
      id: "3333333333333333",
      name: "坏项目",
      variants: [],
    }),
  };
  for (const [name, content] of Object.entries(damaged))
    writeFileSync(join(directory, name), content);
  const before = readdirSync(directory);
  rmSync(join(store.directory, "workspace-initialized.json"));
  const restarted = createStore(store.directory);
  restarted.ensureDemo();
  assert.deepEqual(readdirSync(directory), before);
  assert.deepEqual(
    restarted.list().map((p) => p.id),
    [project.id],
  );
  const report = restarted.catalog(false, true);
  assert.deepEqual(
    report.unreadable.map((i) => i.file).sort(),
    Object.keys(damaged).sort(),
  );
  assert.equal(
    report.projects[0].preview.furniture.length,
    restarted.get(project.id).variants[0].plan.furniture.length,
  );
  assert.equal(report.projects[0].preview.furniture[0].id, undefined);
  for (const [name, content] of Object.entries(damaged)) {
    const id = name.slice(0, -5);
    assert.throws(() => restarted.get(id), { status: 422 });
    assert.throws(() => restarted.restore(id, 1), { status: 422 });
    assert.equal(readFileSync(join(directory, name), "utf8"), content);
  }
});
test("overlapping settings writes follow submission order and a rejected write does not block retry", async (t) => {
  const encryptStarted = Promise.withResolvers(),
    release = Promise.withResolvers();
  const store = createStore(make(t).directory, {
    async encrypt(value) {
      encryptStarted.resolve();
      await release.promise;
      return Buffer.from(value).toString("base64");
    },
    async decrypt(value) {
      return Buffer.from(value, "base64").toString();
    },
  });
  const first = store.setSettings({
    provider: "api",
    model: "first",
    apiKey: "synthetic",
  });
  await encryptStarted.promise;
  const second = store.setSettings({ provider: "codex", codexModel: "second" });
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(store.publicSettings().provider, "codex");
  assert.equal(store.publicSettings().codexModel, "second");
  assert.equal(store.publicSettings().hasKey, true);
  await assert.rejects(store.setSettings({ baseUrl: "invalid" }));
  await store.setSettings({ provider: "api" });
  assert.equal((await store.credentials()).apiKey, "synthetic");
  await assert.rejects(createStore(store.directory).credentials(), /重新输入/);
});
test("opening a legacy plan validates fixtures and history with actionable recovery information", (t) => {
  const store = make(t);
  const p = store.get(store.list()[0].id),
    file = join(store.directory, "projects", p.id + ".json");
  const v = p.variants[0];
  v.plan.elec = [{ id: "outlet-a", kind: "unsupported", x: 200, y: 400 }];
  writeFileSync(file, JSON.stringify(p));
  assert.throws(() => store.get(p.id), /elec\[outlet-a\]\.kind/);
  assert.equal(store.list().length, 0);
  assert.equal(store.catalog().unreadable[0].file, p.id + ".json");
  v.history = [{ plan: structuredClone(v.plan), revision: v.revision }];
  v.plan.elec[0].kind = "socket";
  writeFileSync(file, JSON.stringify(p));
  assert.throws(() => store.get(p.id), /历史版本 1.*elec\[outlet-a\]\.kind/);
  v.history[0].plan.elec[0].kind = "socket";
  const raw = JSON.stringify(p);
  writeFileSync(file, raw);
  const first = store.get(p.id).variants[0];
  assert.equal(first.plan.elec[0].h, 300);
  assert.equal(first.history[0].plan.elec[0].rot, 0);
  assert.equal(first.revision, revision(first.plan));
  assert.equal(first.history[0].revision, revision(first.history[0].plan));
  assert.equal(readFileSync(file, "utf8"), raw);
  assert.equal(store.catalog().unreadable.length, 0);
});
test("damaged settings are preserved until an explicit replacement saves a backup", async (t) => {
  const store = make(t);
  const path = join(store.directory, "settings.json"),
    raw = '{"provider":';
  writeFileSync(path, raw);
  assert.match(store.publicSettings().settingsError, /备份/);
  await assert.rejects(store.credentials(), /settings\.json/);
  await assert.rejects(store.setSettings({ baseUrl: "invalid" }));
  assert.equal(readFileSync(path, "utf8"), raw);
  assert.equal(
    readdirSync(store.directory).filter((f) => f.endsWith(".bak")).length,
    0,
  );
  await store.setSettings({
    provider: "api",
    baseUrl: "https://example.com/v1",
    model: "recovered",
  });
  const backups = readdirSync(store.directory).filter((f) =>
    f.endsWith(".bak"),
  );
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(store.directory, backups[0]), "utf8"), raw);
  assert.equal(store.publicSettings().settingsError, undefined);
  assert.equal((await store.credentials()).model, "recovered");
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
  const copy = store.cloneVariant(p.id, v.id);
  copy.plan.furniture[0].x += 100;
  store.commit(p.id, copy.id, copy.revision, copy.plan, "移动家具");
  assert.deepEqual(store.get(p.id).underlay, underlay);
  assert.throws(
    () => store.commit(p.id, v.id, v.revision, v.plan, "旧校准", null, 0),
    Conflict,
  );
  assert.equal(store.get(p.id).underlayVersion, 1);
  // A repeated successful write after a lost response is idempotent.
  assert.equal(
    store.commit(p.id, v.id, v.revision, v.plan, "校准重试", underlay, 0)
      .underlayVersion,
    1,
  );
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

test("trash survives restart and restores every variant, message, history and image", (t) => {
  const store = make(t),
    p = store.get(store.list()[0].id),
    v = p.variants[0];
  store.cloneVariant(p.id, v.id, "保留的副本");
  store.addMessages(p.id, v.id, [{ role: "user", content: "保留户型" }]);
  const plan = structuredClone(v.plan);
  plan.furniture[0].color = "#abcdef";
  store.commit(p.id, v.id, v.revision, plan);
  const before = store.get(p.id);
  before.image = { dataUrl: "data:image/png;base64,aGVsbG8=" };
  store.save(before);
  const saved = store.get(p.id);
  store.trash(p.id, saved.lifecycle);
  assert.equal(store.list().length, 0);
  assert.throws(() => store.get(p.id), /回收站/);
  assert.throws(() => store.save(saved), /回收站/);
  const reopened = createStore(store.directory);
  reopened.ensureDemo();
  assert.equal(
    reopened.list().length,
    0,
    "clearing projects must not recreate the demo",
  );
  const deleted = reopened.listTrash()[0];
  const restored = reopened.restore(p.id, deleted.lifecycle);
  assert.deepEqual(restored.variants, saved.variants);
  assert.deepEqual(restored.image, saved.image);
  assert.equal(restored.createdAt, saved.createdAt);
  assert.equal(restored.updatedAt, saved.updatedAt);
  assert.equal(reopened.listTrash().length, 0);
  assert.throws(
    () => reopened.assertLifecycle(p.id, saved.lifecycle),
    Conflict,
  );
  assert.throws(() => reopened.save(saved), Conflict);
  assert.throws(() => reopened.restore(p.id, deleted.lifecycle), Conflict);
});

test("design scope persists and deleted project identifiers cannot escape storage", (t) => {
  const store = make(t),
    p = store.get(store.list()[0].id);
  assert.equal(p.designPreferences.layoutLocked, true);
  store.setDesignPreferences(p.id, {
    lifecycle: 0,
    layoutLocked: false,
    allowFreestandingStorage: true,
  });
  assert.equal(
    createStore(store.directory).get(p.id).designPreferences.layoutLocked,
    false,
  );
  for (const id of ["../settings", "a".repeat(17), ""]) {
    assert.throws(() => store.trash(id, 0), /ID/);
    assert.throws(() => store.restore(id, 1), /ID/);
  }
});
