import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { startServer } from "../src/server.mjs";
import { mockProvider } from "./mock-provider.mjs";
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
  assert.equal(app.store.variant(p.id, v.id).v.revision, v.revision);
  assert.equal(mock.requests[0].model, "test");
  assert.ok(mock.requests[0].tools.length);
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
  assert.equal(
    app.store.variant(p.id, v.id).v.plan.furniture[0].x,
    changed.furniture[0].x,
  );
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
  const { req, mock } = await setup(t);
  await req("/api/settings", {
    provider: "api",
    baseUrl: mock.url,
    model: "unauthorized",
  });
  const text = await (await req("/api/settings/test", {})).text();
  assert.match(text, /认证/);
  assert.ok(!text.includes("test-secret"));
});
