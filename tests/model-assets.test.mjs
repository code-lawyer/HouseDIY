import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { createModelLibrary } from "../src/model-assets.mjs";

async function setup(t) {
  const root = resolve(".qa");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "model-integrity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const id = "blue-tetrahedron";
  const raw = await readFile(
    new URL("./fixtures/blue-tetrahedron.glb", import.meta.url),
  );
  const other = Buffer.from(raw);
  const colorAt = other.indexOf("0.85");
  assert.notEqual(colorAt, -1);
  other.write("0.35", colorAt, "ascii");
  const record = {
    id,
    name: "Tetrahedron",
    w: 900,
    d: 1000,
    h: 700,
    b64: raw.toString("base64"),
  };
  const alternate = { ...record, b64: other.toString("base64") };
  const modelsDir = join(directory, "models"),
    file = join(modelsDir, "model-" + id + ".json");
  return {
    library: createModelLibrary(directory),
    directory,
    id,
    record,
    alternate,
    modelsDir,
    file,
  };
}

test("damaged GLB records require explicit repair and preserve the original bytes during concurrent retries", async (t) => {
  const { library, directory, id, record, alternate, modelsDir, file } =
    await setup(t);
  await library.put(id, record);
  const fragment = '{"id":';
  await writeFile(file, fragment);
  await assert.rejects(library.read(id), { status: 422 });
  const plan = { furniture: [{ modelId: id }] };
  await assert.rejects(library.forExport(plan), /已损坏/);
  await assert.rejects(library.put(id, record), { status: 422 });
  await assert.rejects(library.importFor(plan, [record]), { status: 422 });
  await assert.rejects(library.put(id, alternate, { repair: true }), {
    status: 409,
  });
  assert.equal(await readFile(file, "utf8"), fragment);
  const second = createModelLibrary(directory);
  const results = await Promise.allSettled([
    library.put(id, record, { repair: true }),
    second.put(id, alternate, { repair: true }),
    second.put(id, record, { repair: true }),
  ]);
  assert.deepEqual(
    results.map((result) => result.status),
    ["fulfilled", "rejected", "fulfilled"],
  );
  assert.equal(results[1].reason.status, 409);
  assert.equal((await library.read(id)).b64, record.b64);
  const files = await readdir(modelsDir);
  const backups = files.filter((name) => name.endsWith(".bak"));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(modelsDir, backups[0]), "utf8"), fragment);
  assert.ok(!files.some((name) => name.endsWith(".tmp")));
});

test("a healthy legacy GLB acquires an independent checksum that survives a missing or changed asset file", async (t) => {
  const { library, id, record, alternate, modelsDir, file } = await setup(t);
  await mkdir(modelsDir, { recursive: true });
  await writeFile(file, JSON.stringify(record));
  const valid = await library.read(id);
  assert.match(valid.sha256, /^[a-f0-9]{64}$/);
  assert.equal((await readFile(file + ".sha256", "utf8")).trim(), valid.sha256);
  await writeFile(file, JSON.stringify(alternate));
  await assert.rejects(library.read(id), { status: 422 });
  await unlink(file);
  await assert.rejects(library.read(id), { status: 404 });
  await assert.rejects(library.put(id, alternate, { repair: true }), {
    status: 409,
  });
  await library.put(id, record, { repair: true });
  assert.equal((await library.read(id)).b64, record.b64);
});
