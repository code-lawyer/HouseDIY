import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { startServer } from "../src/server.mjs";
import { createModelLibrary } from "../src/model-assets.mjs";
import { mockProvider, recognition } from "./mock-provider.mjs";
mkdirSync(resolve(".qa"), { recursive: true });
async function setup(t) {
  const dir = mkdtempSync(resolve(".qa/server-")),
    app = await startServer({ dataDir: dir }),
    mock = await mockProvider();
  t.after(async () => {
    await app.close();
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const req = (path, body, headers = {}) =>
    fetch(app.origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + app.token,
        "content-type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  await req("/api/settings", {
    provider: "api",
    baseUrl: mock.url,
    model: "test",
    visionModel: "vision",
  });
  return { app, mock, req };
}
test("local service requires a session and rejects cross-site access", async (t) => {
  const { app, req } = await setup(t);
  assert.equal((await fetch(app.origin + "/api/projects")).status, 401);
  assert.equal(
    (
      await req("/api/projects", undefined, {
        Origin: "https://attacker.example",
      })
    ).status,
    403,
  );
  assert.equal((await req("/api/projects")).status, 200);
  const response = await fetch(app.url, { redirect: "manual" });
  assert.equal(response.status, 302);
  assert.match(response.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
});
test("external API edits return validated proposals and never mutate before apply", async (t) => {
  const { app, req, mock } = await setup(t),
    p = app.store.get(app.store.list()[0].id),
    v = p.variants[0];
  const response = await req(`/api/projects/${p.id}/variants/${v.id}/chat`, {
    message: "把沙发改成暖米色",
    revision: v.revision,
    selection: { kind: "furn", id: v.plan.furniture[0].id },
  });
  const text = await response.text(),
    events = text
      .split("\n\n")
      .filter((x) => x.startsWith("data:"))
      .map((x) => JSON.parse(x.slice(6))),
    result = events.find((x) => x.type === "result");
  assert.equal(result.proposal.plan.furniture[0].color, "#d4c5af");
  assert.deepEqual(
    app.store
      .variant(p.id, v.id)
      .v.messages.slice(-2)
      .map(({ role, content }) => [role, content]),
    [
      ["user", "把沙发改成暖米色"],
      ["assistant", result.reply],
    ],
  );
  assert.equal(app.store.variant(p.id, v.id).v.revision, v.revision);
  assert.equal(mock.requests[0].model, "test");
  assert.ok(mock.requests[0].tools.length);
});
test("only the desktop editor's inline scripts receive the response nonce", async (t) => {
  const { app, req } = await setup(t);
  const p = app.store.get(app.store.list()[0].id);
  const response = await req(`/editor/${p.id}/${p.variants[0].id}`);
  const nonce = response.headers
    .get("content-security-policy")
    .match(/'nonce-([^']+)'/)[1];
  const html = await response.text();
  assert.equal(html.split(`nonce="${nonce}"`).length - 1, 3);
  assert.ok(
    html.includes(`<script nonce="${nonce}" type="module" crossorigin>`),
  );
  assert.ok(html.includes('<script id="__shared">window.__SHARED__='));
  assert.ok(html.includes("on:w0,fit2D:"));
  assert.equal(response.headers.get("cache-control"), "no-store");
});
test("session assets cache while pages and API responses do not", async (t) => {
  const { app, req } = await setup(t);
  const style = await req("/design-tokens.css");
  const script = await req("/editor-bridge.js");
  const icon = await req("/logo.svg");
  assert.equal(style.status, 200);
  assert.equal(style.headers.get("cache-control"), "private, max-age=86400");
  assert.equal(script.headers.get("cache-control"), "private, max-age=86400");
  assert.equal(icon.headers.get("cache-control"), "private, max-age=86400");
  assert.equal((await req("/")).headers.get("cache-control"), "no-store");
  assert.equal(
    (await req("/api/projects")).headers.get("cache-control"),
    "no-store",
  );
  const font = await req("/fonts/noto-sans-sc.ttf");
  assert.equal(font.status, 200);
  assert.equal(font.headers.get("cache-control"), "private, max-age=86400");
  assert.equal(
    (await req("/fonts/noto-sans-sc.ttf")).headers.get("content-length"),
    font.headers.get("content-length"),
  );
});
test("image import stores the original bytes separately from the model input", async (t) => {
  const { req, mock } = await setup(t);
  const original = Buffer.from("original-fixture-bytes");
  const preview = "data:image/jpeg;base64,AA==";
  const r = await req("/api/generate", {
    image: {
      width: 600,
      height: 450,
      dataUrl: preview,
      originalDataUrl: "data:image/png;base64," + original.toString("base64"),
      originalName: "原始户型.png",
    },
    name: "原图验收",
    schemeCount: 1,
  });
  const text = await r.text();
  const source = text.match(/"projectId":"([a-f0-9]{16})"/)?.[1];
  assert.ok(source);
  const project = await (await req("/api/projects/" + source)).json();
  assert.equal(project.image.originalAvailable, true);
  assert.equal(project.image.originalDataUrl, undefined);
  const download = await req("/api/projects/" + source + "/source");
  assert.equal(download.headers.get("Content-Type"), "image/png");
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), original);
  assert.equal(mock.requests[0].messages[1].content[1].image_url.url, preview);
  assert.ok(
    !JSON.stringify(mock.requests).includes(original.toString("base64")),
  );
});
test("a damaged project can be identified without breaking healthy projects or trash", async (t) => {
  const { app, req } = await setup(t);
  const active = app.store.get(app.store.list()[0].id);
  const deleted = app.store.create({
    name: "回收项目",
    variants: active.variants,
  });
  app.store.trash(deleted.id, 0);
  const file = "0000000000000000.json";
  const path = join(app.store.directory, "projects", file);
  writeFileSync(path, "{");
  for (const [endpoint, id] of [
    ["/api/projects", active.id],
    ["/api/trash", deleted.id],
  ]) {
    const plain = await req(endpoint),
      response = await req(endpoint + "?diagnostics=1");
    assert.equal(plain.status, 200);
    assert.deepEqual(
      (await plain.json()).map((p) => p.id),
      [id],
    );
    assert.equal(response.status, 200);
    const { projects, unreadable } = await response.json();
    assert.equal(projects[0].id, id);
    assert.equal(!!projects[0].preview, endpoint === "/api/projects");
    assert.deepEqual(unreadable, [{ file, reason: "不是完整的 JSON" }]);
  }
  const broken = await req("/api/projects/0000000000000000");
  assert.equal(broken.status, 422);
  assert.match((await broken.json()).error, /workspace\/projects/);
  assert.equal((await req("/api/projects/" + active.id)).status, 200);
  assert.equal(readFileSync(path, "utf8"), "{");
});
test("permanent deletion requires a current trash entry and prevents stale saves", async (t) => {
  const { app, req } = await setup(t);
  const project = app.store.get(app.store.list()[0].id);
  const path = join(app.store.directory, "projects", project.id + ".json");
  const purge = (lifecycle) =>
    req("/api/trash/purge", { projects: [{ id: project.id, lifecycle }] });

  assert.equal((await purge(project.lifecycle)).status, 409);
  const trash = `/api/projects/${project.id}/trash`;
  const restore = `/api/projects/${project.id}/restore`;
  assert.equal(
    (await req(trash, { lifecycle: project.lifecycle })).status,
    200,
  );
  const [previous] = app.store.listTrash();
  const restored = await req(restore, { lifecycle: previous.lifecycle });
  assert.equal(restored.status, 200);
  assert.equal(
    (await req(trash, { lifecycle: (await restored.json()).lifecycle })).status,
    200,
  );
  assert.equal((await purge(previous.lifecycle)).status, 409);
  assert.ok(existsSync(path));

  const [current] = app.store.listTrash();
  const response = await purge(current.lifecycle);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deletedCount: 1, failedCount: 0 });
  assert.equal(existsSync(path), false);
  assert.deepEqual(app.store.listTrash(), []);
  assert.equal(
    (await req(restore, { lifecycle: current.lifecycle })).status,
    409,
  );
  assert.throws(() => app.store.save(project), /项目不存在/);
  assert.equal(existsSync(path), false);
});
test("clearing trash deletes the confirmed files, including legacy projects", async (t) => {
  const { app, req } = await setup(t);
  const active = app.store.get(app.store.list()[0].id);
  const pathFor = (id) => join(app.store.directory, "projects", id + ".json");
  const addTrashed = (name) => {
    const project = app.store.create({ name, variants: active.variants });
    app.store.trash(project.id, project.lifecycle);
    return project;
  };
  const first = addTrashed("确认清空的旧项目");
  const second = addTrashed("确认清空的项目");
  const legacy = JSON.parse(readFileSync(pathFor(first.id), "utf8"));
  delete legacy.lifecycle;
  writeFileSync(pathFor(first.id), JSON.stringify(legacy));

  const confirmed = (await (await req("/api/trash")).json()).map(
    ({ id, lifecycle }) => ({ id, lifecycle }),
  );
  const late = addTrashed("确认后才移入回收站");
  const brokenPath = pathFor("0000000000000000");
  writeFileSync(brokenPath, "{");
  const purge = (projects) => req("/api/trash/purge", { projects });
  assert.equal((await purge([confirmed[0], confirmed[0]])).status, 400);
  assert.equal(
    (
      await purge([
        ...confirmed,
        { id: active.id, lifecycle: active.lifecycle },
      ])
    ).status,
    409,
  );
  assert.ok(existsSync(pathFor(first.id)));
  assert.ok(existsSync(pathFor(second.id)));

  const response = await purge(confirmed);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deletedCount: 2, failedCount: 0 });
  assert.equal(existsSync(pathFor(first.id)), false);
  assert.equal(existsSync(pathFor(second.id)), false);
  assert.deepEqual(app.store.get(active.id), active);
  assert.deepEqual(
    app.store.listTrash().map(({ id }) => id),
    [late.id],
  );
  assert.equal(readFileSync(brokenPath, "utf8"), "{");
});
test("trash includes damaged projects only when their deletion state is verifiable", async (t) => {
  const { app, req } = await setup(t);
  const sample = app.store.get(app.store.list()[0].id);
  const project = app.store.create({
    name: "方案损坏的回收站项目",
    variants: sample.variants,
  });
  app.store.trash(project.id, project.lifecycle);
  const file = join(app.store.directory, "projects", project.id + ".json");
  const damaged = JSON.parse(readFileSync(file, "utf8"));
  damaged.variants[0].plan = null;
  writeFileSync(file, JSON.stringify(damaged));

  const uncertainId = "0000000000000000";
  const uncertainFile = join(
    app.store.directory,
    "projects",
    uncertainId + ".json",
  );
  const uncertain = JSON.stringify({
    ...damaged,
    id: uncertainId,
    deletedAt: "unknown",
  });
  writeFileSync(uncertainFile, uncertain);
  const status = { id: project.id, lifecycle: damaged.lifecycle };
  const { projects, unreadable } = await (
    await req("/api/trash?diagnostics=1")
  ).json();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].id, project.id);
  assert.equal(projects[0].damaged, true);
  assert.deepEqual(
    unreadable.map(({ file }) => file),
    [uncertainId + ".json"],
  );
  assert.equal(
    (await req(`/api/projects/${project.id}/restore`, status)).status,
    422,
  );
  const purge = (projects) => req("/api/trash/purge", { projects });
  assert.equal((await purge([{ ...status, lifecycle: 0 }])).status, 409);
  assert.equal(
    (await purge([status, { id: uncertainId, lifecycle: status.lifecycle }]))
      .status,
    422,
  );
  assert.ok(existsSync(file));
  const response = await purge([status]);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deletedCount: 1, failedCount: 0 });
  assert.equal(existsSync(file), false);
  assert.equal(readFileSync(uncertainFile, "utf8"), uncertain);
});

test("purge reclaims attachments only after their last verifiable reference is gone", async (t) => {
  const { app, req } = await setup(t);
  const plan = app.store.get(app.store.list()[0].id).variants[0].plan;
  const b64 = readFileSync(
    new URL("./fixtures/blue-tetrahedron.glb", import.meta.url),
  ).toString("base64");
  const asset = (id) => ({ id, name: id, w: 900, d: 1000, h: 700, b64 });
  const planWith = (...ids) => ({
    ...plan,
    furniture: ids.map((id, index) => ({
      ...plan.furniture[0],
      id: "trash-fixture-" + index,
      key: "model:" + id,
    })),
  });
  const importProject = async (ids, embedded = false) => {
    const input = planWith(...ids);
    const response = await req("/api/import", {
      plan: embedded ? { plan: input, models: ids.map(asset) } : input,
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const sharedIds = ["active", "historical", "recycled", "on-shelf"];
  const allIds = ["orphan", ...sharedIds, "unknown-model"];
  const owner = await importProject(allIds, true);
  const unrelated = await importProject(["after-unknown"], true);
  const active = await importProject(["active"]);
  const history = await importProject(["historical"]);
  const historical = history.variants[0];
  app.store.commit(history.id, historical.id, historical.revision, planWith());
  const otherTrash = await importProject(["recycled"]);
  const models = createModelLibrary(app.store.directory);
  await models.put("on-shelf", asset("on-shelf"));

  for (const p of [owner, otherTrash]) app.store.trash(p.id, p.lifecycle);
  const purge = async (id, cleanupDeferred) => {
    const { lifecycle } = app.store.listTrash().find((p) => p.id === id);
    const response = await req("/api/trash/purge", {
      projects: [{ id, lifecycle }],
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      deletedCount: 1,
      failedCount: 0,
      ...(cleanupDeferred && { cleanupDeferred }),
    });
  };
  const assetFile = (id) =>
    join(app.store.directory, "models", "model-" + id + ".json");
  writeFileSync(assetFile("unknown-model"), "{");
  await purge(owner.id, 1);
  assert.equal(existsSync(assetFile("orphan")), false);
  assert.equal((await req("/api/models/orphan")).status, 404);
  for (const id of [...sharedIds, "after-unknown"])
    assert.equal((await models.read(id)).b64, b64);
  assert.equal(readFileSync(assetFile("unknown-model"), "utf8"), "{");
  assert.ok(app.store.get(active.id));

  await purge(otherTrash.id, 1);
  assert.equal(existsSync(assetFile("recycled")), false);
  const unreadable = join(
    app.store.directory,
    "projects",
    "0000000000000000.json",
  );
  writeFileSync(unreadable, "{");
  app.store.trash(unrelated.id, unrelated.lifecycle);
  await purge(unrelated.id, 2);
  assert.equal((await models.read("after-unknown")).b64, b64);
  assert.equal(readFileSync(unreadable, "utf8"), "{");
  rmSync(unreadable);
  const restarted = await startServer({ dataDir: app.store.directory });
  try {
    assert.equal(existsSync(assetFile("after-unknown")), false);
    assert.equal(readFileSync(assetFile("unknown-model"), "utf8"), "{");
  } finally {
    await restarted.close();
  }
});
test("invalid image scale or non-integer scheme counts are rejected before a provider call", async (t) => {
  const { mock, req } = await setup(t);
  const image = {
    width: 600,
    height: 450,
    dataUrl: "data:image/png;base64,aGVsbG8=",
  };
  for (const input of [
    { schemeCount: 1.5 },
    { widthMeters: 0 },
    { widthMeters: "" },
  ]) {
    const response = await req("/api/generate", { image, ...input });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /方案数量|跨度/);
  }
  assert.equal(mock.requests.length, 0);
});
test("manual changes during model execution reject stale proposal", async (t) => {
  const { app, req, mock } = await setup(t),
    p = app.store.get(app.store.list()[0].id),
    v = p.variants[0];
  mock.setDelay(180);
  const request = req(`/api/projects/${p.id}/variants/${v.id}/chat`, {
    message: "改沙发颜色",
    revision: v.revision,
  });
  while (!mock.requests.length) await new Promise((r) => setTimeout(r, 10));
  const changed = structuredClone(v.plan);
  changed.furniture[0].x += 100;
  app.store.commit(p.id, v.id, v.revision, changed);
  const text = await (await request).text();
  assert.match(text, /409/);
  assert.match(text, /手动修改/);
  assert.deepEqual(app.store.variant(p.id, v.id).v.messages, v.messages);
  assert.equal(
    app.store.variant(p.id, v.id).v.plan.furniture[0].x,
    changed.furniture[0].x,
  );
});
test("overlapping chat requests cannot commit a reply based on superseded history", async (t) => {
  const { app, req, mock } = await setup(t);
  const p = app.store.get(app.store.list()[0].id);
  const v = p.variants[0];
  const send = (message) =>
    req(`/api/projects/${p.id}/variants/${v.id}/chat`, {
      message,
      revision: v.revision,
    });
  const held = mock.holdNextResponse();
  const first = send("较早请求");
  try {
    await held.received;
    const second = eventsFrom(await (await send("先完成的请求")).text());
    assert.ok(second.some((event) => event.type === "result"));
  } finally {
    held.release();
  }
  const rejected = eventsFrom(await (await first).text());
  assert.ok(
    rejected.some((event) => event.type === "error" && event.status === 409),
  );
  const messages = app.store.variant(p.id, v.id).v.messages;
  assert.equal(messages.length, v.messages.length + 2);
  assert.equal(messages.at(-2).content, "先完成的请求");
});
test("image recognition persists three variants and image underlay", async (t) => {
  const { app, req } = await setup(t);
  const response = await req("/api/generate", {
    image: {
      width: 600,
      height: 450,
      dataUrl: "data:image/png;base64,aGVsbG8=",
    },
    height: 2800,
    schemeCount: 3,
  });
  const text = await response.text();
  const result = text
    .split("\n\n")
    .filter((x) => x.startsWith("data:"))
    .map((x) => JSON.parse(x.slice(6)))
    .find((x) => x.type === "result");
  assert.ok(result);
  const p = app.store.get(result.projectId);
  assert.equal(p.variants.length, 3);
  assert.equal(p.underlay.mmPerPx, 10);
  assert.equal(p.variants[0].plan.walls.length, 4);
});
test("provider errors are actionable without echoing provider bodies", async (t) => {
  const { app, req, mock } = await setup(t);
  await req("/api/settings", {
    provider: "api",
    baseUrl: mock.url,
    model: "unauthorized",
  });
  const text = await (await req("/api/settings/test", {})).text();
  assert.match(text, /认证/);
  assert.ok(!text.includes("test-secret"));
  const p = app.store.get(app.store.list()[0].id),
    v = p.variants[0];
  const chat = await req(`/api/projects/${p.id}/variants/${v.id}/chat`, {
    message: "试试换色",
    revision: v.revision,
  });
  assert.ok(eventsFrom(await chat.text()).some((e) => e.type === "error"));
  assert.deepEqual(app.store.variant(p.id, v.id).v.messages, v.messages);
});

const eventsFrom = (text) =>
  text
    .split("\n\n")
    .filter((x) => x.startsWith("data:"))
    .map((x) => JSON.parse(x.slice(6)));
test("a cabinet still intersecting the wall by 56 mm opens in an editable project", async (t) => {
  const { app, req, mock } = await setup(t);
  const draft = structuredClone(recognition);
  draft.schemes[0].furniture = [{ key: "counter", at: [200, 54.4] }];
  mock.enqueueRecognition(draft, draft);

  const response = await req("/api/generate", {
    image: {
      width: 600,
      height: 450,
      dataUrl: "data:image/png;base64,aGVsbG8=",
    },
    schemeCount: 1,
  });
  const events = eventsFrom(await response.text());
  assert.equal(mock.requests.length, 2);
  assert.match(
    mock.requests[1].messages[1].content[0].text,
    /固定结构约 56 mm/,
  );
  const result = events.find((event) => event.type === "result");
  assert.ok(result?.projectId, JSON.stringify(events));
  assert.equal(result.draftStatus, "review");
  const project = app.store.get(result.projectId);
  assert.equal(project.variants[0].plan.furniture[0].key, "counter");
  assert.equal(project.underlay.src, "data:image/png;base64,aGVsbG8=");
});
test("recognition corrects furniture conflicts before saving generated variants", async (t) => {
  const { app, req, mock } = await setup(t);
  const bad = structuredClone(recognition);
  bad.schemes[0].furniture.push({ key: "cabWardrobe", at: [300, 300] });
  mock.enqueueRecognition(bad);
  const events = eventsFrom(
    await (
      await req("/api/generate", {
        image: {
          width: 600,
          height: 450,
          dataUrl: "data:image/png;base64,aGVsbG8=",
        },
      })
    ).text(),
  );
  const result = events.find((e) => e.type === "result");
  assert.ok(result?.projectId, JSON.stringify(events));
  assert.equal(result.draftStatus, undefined);
  assert.equal(mock.requests.length, 2);
  assert.match(mock.requests[1].messages[1].content[0].text, /背面没有合适/);
  const saved = app.store.get(result.projectId);
  assert.equal(saved.variants[0].plan.furniture.length, 1);
  assert.ok(saved.assumptions.some((s) => s.includes("出入口")));
});
test("a door with an unknown wall keeps its source location and the rest of the 3D project", async (t) => {
  const { app, req, mock } = await setup(t);
  const count = app.store.list().length;
  const bad = structuredClone(recognition);
  bad.openings.push({ wall: 9, center: [300, 430], width: 900, type: "door" });
  mock.enqueueRecognition(bad, bad);
  const events = eventsFrom(
    await (
      await req("/api/generate", {
        image: {
          width: 600,
          height: 450,
          dataUrl: "data:image/png;base64,aGVsbG8=",
        },
      })
    ).text(),
  );
  assert.equal(mock.requests.length, 2);
  const source = events.find((e) => e.type === "source");
  const result = events.find((e) => e.type === "result");
  assert.equal(result.projectId, source.projectId);
  const { plan } = app.store.get(result.projectId).variants[0];
  assert.equal(plan.walls.length, 4);
  assert.equal(plan.openings.length, 1);
  assert.deepEqual(plan.pendingOpenings[0].pixel, [300, 430]);
  assert.equal(plan.pendingOpenings[0].width, 900);
  assert.equal(app.store.list().length, count + 1);
});
test("the saved source can be reopened before recognition finishes and retried after total failure", async (t) => {
  const { app, req, mock } = await setup(t);
  const image = {
    width: 600,
    height: 450,
    dataUrl: "data:image/png;base64,aGVsbG8=",
  };
  const count = app.store.list().length;
  mock.enqueueRecognition({ walls: [] }, { walls: [] });
  const held = mock.holdNextResponse();
  const request = req("/api/generate", { image, schemeCount: 1 });
  await held.received;
  const source = app.store.get(app.store.list().find((p) => p.hasImage).id);
  held.release();
  assert.equal(source.underlay.src, image.dataUrl);
  assert.equal(source.underlay.visible, true);
  assert.equal(source.variants[0].plan.walls.length, 0);
  const result = eventsFrom(await (await request).text()).at(-1);
  assert.equal(result.draftStatus, "underlay");
  assert.equal(result.projectId, source.id);
  const retry = await req("/api/generate", {
    projectId: source.id,
    lifecycle: 0,
  });
  assert.equal(eventsFrom(await retry.text()).at(-1).projectId, source.id);
  assert.equal(app.store.get(source.id).variants[0].plan.walls.length, 4);
  assert.equal(app.store.list().length, count + 1);
});
test("a provider outage still saves the image and a late retry cannot replace manual tracing", async (t) => {
  const { app, req, mock } = await setup(t);
  const image = {
    width: 600,
    height: 450,
    dataUrl: "data:image/png;base64,AA==",
  };
  await req("/api/settings", {
    provider: "api",
    baseUrl: mock.url,
    model: "unauthorized",
    visionModel: "unauthorized",
  });
  const failed = eventsFrom(
    await (await req("/api/generate", { image, schemeCount: 1 })).text(),
  ).at(-1);
  let p = app.store.get(failed.projectId);
  assert.equal(failed.draftStatus, "underlay");
  assert.match(p.imageImport.reason, /认证/);
  assert.equal(p.underlay.src, image.dataUrl);
  await req("/api/settings", {
    provider: "api",
    baseUrl: mock.url,
    model: "test",
    visionModel: "vision",
  });
  const held = mock.holdNextResponse();
  const retry = req("/api/generate", { projectId: p.id, lifecycle: 0 });
  await held.received;
  const v = p.variants[0],
    manual = structuredClone(v.plan);
  manual.nodes = [
    { id: "n1", x: 0, y: 0 },
    { id: "n2", x: 1800, y: 0 },
  ];
  manual.walls = [{ id: "w", a: "n1", b: "n2", t: 120, status: "existing" }];
  app.store.commit(p.id, v.id, v.revision, manual);
  held.release();
  assert.equal(eventsFrom(await (await retry).text()).at(-1).status, 409);
  p = app.store.get(p.id);
  assert.deepEqual(p.variants[0].plan.walls, manual.walls);
  const separate = eventsFrom(
    await (
      await req("/api/generate", {
        projectId: p.id,
        lifecycle: 0,
        copySource: true,
      })
    ).text(),
  ).at(-1);
  assert.notEqual(separate.projectId, p.id);
  assert.equal(
    app.store.get(separate.projectId).variants[0].plan.walls.length,
    4,
  );
  assert.deepEqual(app.store.get(p.id).variants[0].plan.walls, manual.walls);
});
test("stopping during automatic correction preserves the already drawable 3D draft", async (t) => {
  const { app, req, mock } = await setup(t);
  const partial = structuredClone(recognition);
  partial.schemes[0].furniture = [{ key: "counter", at: [200, 54.4] }];
  mock.enqueueRecognition(partial);
  const first = mock.holdNextResponse();
  const request = req("/api/generate", {
    image: { width: 600, height: 450, dataUrl: "data:image/png;base64,AA==" },
    schemeCount: 1,
  });
  await first.received;
  const second = mock.holdNextResponse();
  const pid = app.store.list().find((p) => p.hasImage).id;
  first.release();
  await second.received;
  const before = app.store.get(pid).variants[0];
  assert.equal(before.plan.walls.length, 4);
  assert.equal(before.plan.furniture[0].key, "counter");
  try {
    await (await request).body.cancel();
  } finally {
    second.release();
  }
  await second.completed;
  const after = app.store.get(pid).variants[0];
  assert.equal(after.revision, before.revision);
});
test("a deleted and restored image draft cannot receive a late recognition result", async (t) => {
  const { app, req, mock } = await setup(t);
  const held = mock.holdNextResponse();
  const request = req("/api/generate", {
    image: { width: 600, height: 450, dataUrl: "data:image/png;base64,AA==" },
  });
  await held.received;
  const pid = app.store.list().find((p) => p.hasImage).id;
  const trashed = await (
    await req(`/api/projects/${pid}/trash`, { lifecycle: 0 })
  ).json();
  await req(`/api/projects/${pid}/restore`, { lifecycle: 1 });
  held.release();
  const events = eventsFrom(await (await request).text());
  assert.ok(!events.some((e) => e.type === "result"));
  assert.equal(trashed.id, pid);
  assert.equal(app.store.get(pid).variants[0].plan.walls.length, 0);
  assert.equal(app.store.get(pid).lifecycle, 2);
});
test("API retries a rejected layout and returns only the corrected proposal", async (t) => {
  const { app, req, mock } = await setup(t),
    p = app.store.get(app.store.list()[0].id),
    v = p.variants[0];
  mock.enqueueOperations(
    [{ op: "add_furniture", key: "cabWardrobe", x: 3000, y: 2200 }],
    [{ op: "update_furniture", id: v.plan.furniture[0].id, color: "#abcdef" }],
  );
  const response = await req(`/api/projects/${p.id}/variants/${v.id}/chat`, {
    revision: v.revision,
    message: "调整家具",
  });
  const events = eventsFrom(await response.text()),
    result = events.find((e) => e.type === "result");
  assert.ok(result?.proposal, JSON.stringify(events));
  assert.equal(mock.requests.length, 2);
  assert.ok(
    mock.requests[1].messages.some(
      (m) => m.role === "tool" && m.content.includes("storage-support"),
    ),
  );
  assert.match(mock.requests[0].messages[0].content, /装修编辑知识 v1/);
  assert.equal(result.proposal.plan.furniture.length, v.plan.furniture.length);
  assert.equal(app.store.variant(p.id, v.id).v.revision, v.revision);
});
test("review endpoint rejects bad candidates without saving and respects scope changes", async (t) => {
  const { app, req } = await setup(t),
    p = app.store.get(app.store.list()[0].id),
    v = p.variants[0];
  const plan = structuredClone(v.plan);
  plan.furniture[0].x = 5800;
  const r = await req(`/api/projects/${p.id}/variants/${v.id}/review`, {
    revision: v.revision,
    plan,
  });
  assert.equal(r.status, 400);
  assert.match(await r.text(), /嵌入/);
  assert.equal(app.store.variant(p.id, v.id).v.revision, v.revision);
  const resized = structuredClone(v.plan);
  resized.openings.find((o) => o.type === "door").width = 1000;
  const locked = await req(`/api/projects/${p.id}/variants/${v.id}/review`, {
    revision: v.revision,
    plan: resized,
  });
  assert.equal(locked.status, 400);
  assert.match(await locked.text(), /固定户型/);
  assert.equal(
    (
      await req(`/api/projects/${p.id}/preferences`, {
        layoutLocked: false,
        allowFreestandingStorage: false,
      })
    ).status,
    200,
  );
  const review = (revision, plan) =>
    req(`/api/projects/${p.id}/variants/${v.id}/review`, { revision, plan });
  const protectedReview = await review(v.revision, resized);
  assert.equal(protectedReview.status, 400);
  assert.match((await protectedReview.json()).error, /承重/);
  assert.equal(app.store.variant(p.id, v.id).v.revision, v.revision);
  const verified = structuredClone(v.plan);
  const door = verified.openings.find((o) => o.type === "door");
  const wall = verified.walls.find((w) => w.id === door.wall);
  wall.bearing = false;
  wall.bearingFrom = "drawing";
  const saved = app.store.commit(p.id, v.id, v.revision, verified);
  door.width = 1000;
  assert.equal((await review(saved.revision, verified)).status, 200);
});
test("deletion cancels a running model and restored projects reject stale writes", async (t) => {
  const { app, req, mock } = await setup(t),
    p = app.store.get(app.store.list()[0].id),
    v = p.variants[0];
  const held = mock.holdNextResponse();
  const response = await req(`/api/projects/${p.id}/variants/${v.id}/chat`, {
    message: "换色",
    revision: v.revision,
    lifecycle: p.lifecycle,
  });
  await held.received;
  assert.equal(
    (await req(`/api/projects/${p.id}/trash`, { lifecycle: p.lifecycle }))
      .status,
    200,
  );
  assert.equal((await req(`/api/projects/${p.id}`)).status, 410);
  const deleted = (await (await req("/api/trash")).json())[0];
  assert.equal(
    (
      await req(`/api/projects/${p.id}/restore`, {
        lifecycle: deleted.lifecycle,
      })
    ).status,
    200,
  );
  held.release();
  const events = eventsFrom(await response.text());
  assert.ok(!events.some((e) => e.proposal));
  assert.equal(
    (
      await req(`/api/projects/${p.id}/variants/${v.id}/save`, {
        revision: v.revision,
        plan: v.plan,
        lifecycle: 0,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await req(`/api/projects/${p.id}/variants/${v.id}/note`, {
        content: "过期记录",
        lifecycle: 0,
      })
    ).status,
    409,
  );
  assert.equal(
    (await req(`/api/projects/${p.id}/variants/${v.id}/copy`, { lifecycle: 0 }))
      .status,
    409,
  );
  const restored = app.store.get(p.id);
  assert.deepEqual(restored.variants[0].messages, v.messages);
  assert.equal(
    restored.variants[0].plan.furniture[0].color,
    v.plan.furniture[0].color,
  );
  assert.equal(
    (
      await req(`/api/projects/${p.id}/variants/${v.id}/save`, {
        revision: v.revision,
        plan: v.plan,
        lifecycle: restored.lifecycle,
      })
    ).status,
    200,
  );
});
