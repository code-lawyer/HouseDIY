import puppeteer from "puppeteer-core";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { startServer } from "../src/server.mjs";
import { mockProvider } from "../tests/mock-provider.mjs";

const directory = resolve(
  process.env.HOUSEDIY_FIRST_FIXES_DIR || ".qa/first-fixes",
);
mkdirSync(directory, { recursive: true });
const dataDir = mkdtempSync(join(directory, "data-"));
let app = await startServer({ dataDir }),
  browser;
const mock = await mockProvider(),
  checks = [],
  errors = [];
await app.store.setSettings({
  provider: "api",
  baseUrl: mock.url,
  model: "test",
});
const project = app.store.get(app.store.list()[0].id),
  variant = project.variants[0];
variant.plan.furniture = [];
variant.plan.walls[2].bearing = false;
variant.plan.walls[2].bearingFrom = "drawing";
app.store.save(project);
const pass = (name) => {
  checks.push(name);
  console.log("PASS " + name);
};
try {
  browser = await puppeteer.launch({
    executablePath:
      process.env.HOUSEDIY_BROWSER ||
      [
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      ].find(existsSync),
    headless: true,
    args: [
      "--no-proxy-server",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
    defaultViewport: { width: 1366, height: 900 },
  });
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setRequestInterception(true);
  page.on("request", (r) =>
    r.url().endsWith("/api/codex/status")
      ? r.respond({
          status: 200,
          contentType: "application/json",
          body: '{"available":false,"message":"离线验收"}',
        })
      : r.continue(),
  );
  const ready = async () => {
    await page.waitForFunction(
      () =>
        !document.querySelector("#editor-view").hidden &&
        document.querySelector("#editor-loading").hidden &&
        document.querySelector("#save-status").textContent === "已保存",
    );
    return (await page.$("#designer")).contentFrame();
  };
  const send = async (text) => {
    await page.type("#chat-input", text);
    await page.click("#send-chat");
  };
  const done = () =>
    page.waitForFunction(
      () =>
        !document.querySelector("#send-chat").hidden &&
        document.querySelector("#editor-loading").hidden,
    );
  await page.goto(app.url);
  await page.waitForSelector(".project-card");
  await page.click(".project-card");
  let frame = await ready();
  await page.click("#design-scope summary");
  assert.equal(await page.$eval("#layout-locked", (e) => e.checked), true);
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/preferences") && r.status() === 200,
    ),
    page.click("#layout-locked"),
  ]);
  await ready();
  assert.equal(app.store.get(project.id).designPreferences.layoutLocked, false);
  pass("Design scope is explicit in the editor and persists in the project");

  const wall = app.store.get(project.id).variants[0].plan.walls[2];
  const scenarios = [
    [
      "oversized single door",
      [
        {
          op: "add_opening",
          wallId: wall.id,
          pos: 2800,
          width: 5600,
          type: "door",
        },
      ],
      "门",
    ],
    [
      "closed dark room",
      [
        { op: "add_wall", a: [3500, 1500], b: [4900, 1500] },
        { op: "add_wall", a: [4900, 1500], b: [4900, 2900] },
        { op: "add_wall", a: [4900, 2900], b: [3500, 2900] },
        { op: "add_wall", a: [3500, 2900], b: [3500, 1500] },
      ],
      "封闭",
    ],
    [
      "wardrobe blocks entry",
      [
        {
          op: "add_furniture",
          key: "cabWardrobe",
          x: 650,
          y: 3400,
          w: 900,
          rot: 270,
        },
      ],
      "通路",
    ],
    [
      "unintended central wardrobe",
      [{ op: "add_furniture", key: "cabWardrobe", x: 3000, y: 2200, w: 1200 }],
      "背面",
    ],
  ];
  for (const [name, operations, reason] of scenarios) {
    const before = await frame.evaluate(() =>
      JSON.stringify(window.__designer.app.plan),
    );
    const stored = app.store.get(project.id).variants[0].revision;
    mock.enqueueOperations(...Array.from({ length: 5 }, () => operations));
    await send("添加一组测试家具");
    await done();
    assert.equal(
      await frame.evaluate(() => JSON.stringify(window.__designer.app.plan)),
      before,
      name,
    );
    assert.equal(app.store.get(project.id).variants[0].revision, stored, name);
    assert.ok(
      (await page.$eval("#messages", (e) => e.textContent)).includes(reason),
      name,
    );
    assert.equal(await page.$eval("#pending-proposal", (e) => e.hidden), true);
    pass(name + " rejected before changing or saving the actual editor");
  }
  await page.screenshot({ path: join(directory, "blocked-layout.png") });

  // Direct bridge calls must also preflight; no hidden replacement / Undo step.
  const bridgeBefore = await frame.evaluate(() =>
    JSON.stringify(window.__designer.app.plan),
  );
  const rejected = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const editor = document.querySelector("#designer").contentWindow;
        const listener = (e) => {
          if (e.source === editor && e.data.requestId === "check-bad") {
            removeEventListener("message", listener);
            resolve(e.data);
          }
        };
        addEventListener("message", listener);
        const d = editor.__designer,
          plan = structuredClone(d.app.plan);
        plan.openings.find((o) => o.type === "door").width = 4000;
        editor.postMessage(
          {
            source: "housediy-shell",
            requestId: "check-bad",
            action: "apply",
            payload: {
              plan,
              expected: JSON.stringify(d.app.plan),
              preferences: { layoutLocked: false },
            },
          },
          location.origin,
        );
      }),
  );
  assert.match(rejected.error, /普通单扇门/);
  assert.equal(
    await frame.evaluate(() => JSON.stringify(window.__designer.app.plan)),
    bridgeBefore,
  );
  pass("Editor bridge rejects a bad candidate before replacing geometry");

  mock.enqueueOperations([
    {
      op: "add_furniture",
      key: "cabWardrobe",
      x: 5400,
      y: 2100,
      rot: 90,
      w: 1200,
    },
  ]);
  await send("添加靠墙衣柜");
  await done();
  assert.equal(
    await frame.evaluate(() => window.__designer.app.plan.furniture.length),
    1,
  );
  assert.equal(
    app.store.get(project.id).variants[0].plan.furniture[0].key,
    "cabWardrobe",
  );
  // Manual editing remains possible; the visible check uses the same rules.
  await frame.evaluate(() => {
    const d = window.__designer;
    Object.assign(d.app.plan.furniture[0], { x: 3000, y: 2200, rot: 0 });
    d.commit();
  });
  await page.click("#check-plan");
  await page.waitForFunction(() =>
    document
      .querySelector("#messages .message:last-child")
      .textContent.includes("背面没有合适"),
  );
  await page.screenshot({ path: join(directory, "manual-layout-check.png") });
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/preferences") && r.status() === 200,
    ),
    page.click("#freestanding-storage"),
  ]);
  await done();
  const checkCount = await page.$$eval(
    "#messages .message",
    (items) => items.length,
  );
  await page.click("#check-plan");
  await page.waitForFunction(
    (count) => document.querySelectorAll("#messages .message").length > count,
    {},
    checkCount,
  );
  assert.ok(
    !(
      await page.$eval("#messages .message:last-child", (e) => e.textContent)
    ).includes("背面没有合适"),
  );
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/preferences") && r.status() === 200,
    ),
    page.click("#freestanding-storage"),
  ]);
  await done();
  await page.click("#undo-ai");
  await ready();
  assert.equal(
    await frame.evaluate(() => window.__designer.app.plan.furniture[0].x),
    5400,
  );
  pass(
    "Visible checks catch a manually misplaced cabinet and respect the explicit freestanding preference",
  );
  await page.click("#undo-ai");
  await ready();
  await frame.waitForFunction(
    () => window.__designer.app.plan.furniture.length === 0,
  );
  pass("A valid wall-backed wardrobe applies, saves, and undoes normally");

  // Cancel must preserve the active project even with a model request in flight.
  const held = mock.holdNextResponse();
  await send("添加绿植");
  await held.received;
  await page.click("#delete-project");
  await page.click("#cancel-delete");
  assert.equal(app.store.list().length, 1);
  await page.click("#delete-project");
  await page.screenshot({ path: join(directory, "delete-confirmation.png") });
  const saved = app.store.get(project.id);
  await page.click("#confirm-delete");
  await page.waitForFunction(
    () =>
      !document.querySelector("#home-view").hidden &&
      document.querySelectorAll(".project-card").length === 0,
  );
  assert.equal(app.store.listTrash().length, 1);
  await page.click("#open-trash");
  await page.waitForSelector(".trash-row");
  await page.screenshot({ path: join(directory, "recycle-bin.png") });
  await page.click(".trash-restore");
  await page.waitForSelector(".project-card");
  held.release();
  await held.completed;
  const restored = app.store.get(project.id);
  assert.deepEqual(restored.variants, saved.variants);
  pass(
    "Cancel preserves project; deleting during AI work and restoring preserves all saved data without late mutations",
  );

  await page.click('[data-close="trash-dialog"]');
  await page.click(".project-delete");
  await page.click("#confirm-delete");
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".project-card").length === 0 &&
      !document.querySelector("#delete-dialog").open,
  );
  await app.close();
  app = await startServer({ dataDir });
  await page.goto(app.url);
  await page.waitForSelector(".empty-projects");
  assert.equal(app.store.list().length, 0);
  assert.equal(app.store.listTrash().length, 1);
  await page.click("#open-trash");
  await page.waitForSelector(".trash-row");
  await page.click(".trash-restore");
  await page.waitForSelector(".project-card");
  await page.click('[data-close="trash-dialog"]');
  await page.click(".project-card");
  frame = await ready();
  assert.equal(await page.$eval("#layout-locked", (e) => e.checked), false);
  assert.deepEqual(app.store.get(project.id).variants, saved.variants);
  pass(
    "Delete, service restart, empty state, restore and reopen retain project history and scope without reseeding a demo",
  );
  assert.deepEqual(errors, []);
} catch (error) {
  if (browser)
    await (
      await browser.pages()
    )
      .at(-1)
      ?.screenshot({ path: join(directory, "failure.png") })
      .catch(() => {});
  throw error;
} finally {
  writeFileSync(
    join(directory, "results.json"),
    JSON.stringify({ checks, errors, dataDir }, null, 2),
  );
  await browser?.close();
  await app.close();
  await mock.close();
}
console.log(JSON.stringify({ checks: checks.length, errors, directory }));
