import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.mjs";

const image = {
  originalName: "原图.png",
  originalDataUrl:
    "data:image/png;base64," + Buffer.alloc(512_000, 1).toString("base64"),
  dataUrl:
    "data:image/jpeg;base64," + Buffer.alloc(64_000, 2).toString("base64"),
  width: 600,
  height: 400,
};

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), "housediy-images-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return createStore(dir);
}

test("image drafts share external attachments, and ordinary autosaves work without opening them", (t) => {
  const store = workspace(t);
  const p = store.createImageDraft(image, { name: "底图测试" });
  const file = join(store.directory, "projects", p.id + ".json");
  const dir = join(store.directory, "images");
  const record = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(record.image.dataSha256, record.underlay.srcSha256);
  assert.equal(readdirSync(dir).length, 2);
  assert.ok(readFileSync(file).length < 5000);
  assert.equal(p.image.dataUrl, image.dataUrl);
  assert.equal(p.underlay.src, image.dataUrl);
  assert.equal(p.image.originalDataUrl, undefined);

  const reopened = createStore(store.directory);
  renameSync(dir, dir + "-offline");
  const v = p.variants[0];
  v.plan.name = "更新后的方案";
  const saved = reopened.commit(
    p.id,
    v.id,
    v.revision,
    v.plan,
    "edit",
    undefined,
    undefined,
    { includeUnderlay: false },
  );
  assert.ok(!Object.hasOwn(saved, "underlay"));
  assert.equal(reopened.list()[0].id, p.id);
  reopened.addMessages(p.id, v.id, [{ role: "user", content: "已保存" }]);
  assert.throws(() => reopened.get(p.id), /workspace\/images/);
  renameSync(dir + "-offline", dir);
  assert.equal(reopened.get(p.id).underlay.src, image.dataUrl);
  assert.equal(reopened.get(p.id).variants[0].plan.name, "更新后的方案");
  assert.deepEqual(reopened.originalImage(p.id), {
    dataUrl: image.originalDataUrl,
    name: image.originalName,
  });
  writeFileSync(
    join(dir, "source-" + record.image.originalSha256 + ".txt"),
    "damaged",
  );
  assert.throws(() => reopened.originalImage(p.id), /校验失败/);
});

test("legacy inline projects migrate only after attachments can be saved", (t) => {
  const store = workspace(t);
  const p = store.createImageDraft(image, {});
  const v = p.variants[0];
  const file = join(store.directory, "projects", p.id + ".json");
  const dir = join(store.directory, "images");
  const legacy = JSON.stringify({ ...p, image: { ...image } });
  writeFileSync(file, legacy);
  renameSync(dir, dir + "-previous");
  writeFileSync(dir, "simulated unavailable image directory");
  const reopened = createStore(store.directory);
  assert.equal(reopened.get(p.id).image.originalDataUrl, image.originalDataUrl);
  assert.throws(() => reopened.addMessages(p.id, v.id, []));
  assert.equal(readFileSync(file, "utf8"), legacy);
  rmSync(dir);
  reopened.addMessages(p.id, v.id, [{ role: "assistant", content: "保存" }]);
  assert.ok(!readFileSync(file, "utf8").includes("base64"));
  assert.equal(reopened.originalImage(p.id).dataUrl, image.originalDataUrl);
  assert.equal(reopened.get(p.id).underlay.src, image.dataUrl);
});

test("purge keeps shared images, trashed references and assets with unknown ownership", (t) => {
  const store = workspace(t);
  const a = store.createImageDraft(image, {});
  const b = store.createImageDraft(a.image, {});
  const dir = join(store.directory, "images");
  const purge = (p) =>
    store.purgeTrash([{ id: p.id, lifecycle: p.lifecycle + 1 }], () => {});
  store.trash(a.id, 0);
  store.trash(b.id, 0);
  purge(a);
  assert.equal(readdirSync(dir).length, 2);
  renameSync(dir, dir + "-offline");
  assert.throws(() => store.restore(b.id, 1), /workspace\/images/);
  assert.equal(store.listTrash()[0].id, b.id);
  renameSync(dir + "-offline", dir);
  const restored = store.restore(b.id, 1);
  assert.equal(store.originalImage(b.id).dataUrl, image.originalDataUrl);
  store.trash(b.id, restored.lifecycle);
  const unreadable = join(store.directory, "projects", "0000000000000000.json");
  writeFileSync(unreadable, "{");
  purge(restored);
  assert.equal(readdirSync(dir).length, 2);
  rmSync(unreadable);
  store.pruneImages();
  assert.deepEqual(readdirSync(dir), []);
});
