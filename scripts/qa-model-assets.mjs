import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";
import { startServer } from "../src/server.mjs";

const root = resolve(process.env.HOUSEDIY_MODEL_QA_DIR || ".qa/model-assets");
mkdirSync(root, { recursive: true });
const fixture = resolve("tests/fixtures/blue-tetrahedron.glb");
const dataDir = mkdtempSync(join(root, "model-workspace-"));
let app = await startServer({ dataDir });
let browser;
const checks = [],
  errors = [];
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
    defaultViewport: { width: 1366, height: 768 },
  });
  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const appData = () => app.store.get(app.store.list()[0].id);
  const ready = () =>
    page.waitForFunction(
      () =>
        !document.querySelector("#editor-view").hidden &&
        document.querySelector("#editor-loading").hidden,
    );
  const frame = async () => (await page.$("#designer")).contentFrame();
  async function repairedFrame(previousSource) {
    await page.waitForFunction(
      (source) =>
        document.querySelector("#designer").src !== source &&
        document.querySelector("#editor-view").getAttribute("aria-busy") ===
          "false" &&
        document.querySelector("#model-feedback").hidden &&
        document.querySelector("#editor-loading").hidden,
      {},
      previousSource,
    );
    return frame();
  }
  async function openProject(projectId) {
    await page.goto(app.url);
    const card = '[data-project-id="' + projectId + '"] .project-card';
    await page.waitForSelector(card);
    await page.click(card);
    await ready();
    return frame();
  }
  async function verifyRendered(editor, id) {
    await editor.waitForFunction(
      (id) => {
        const d = window.__designer;
        if (
          !d.CAT["model:" + id] ||
          !d.app.plan.furniture.some((f) => f.modelId === id)
        )
          return false;
        let blue = false;
        d.S3.sceneRefs().scene.traverse((o) => {
          const c = o.material?.color;
          if (
            o.isMesh &&
            c &&
            Math.abs(c.r - 0.06) < 0.001 &&
            Math.abs(c.b - 0.85) < 0.001
          )
            blue = true;
        });
        return blue;
      },
      { timeout: 30000 },
      id,
    );
  }
  const pass = (name) => {
    checks.push(name);
    console.log("PASS " + name);
  };
  const project = appData();
  const underlay = {
    src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aUEkAAAAASUVORK5CYII=",
    imgW: 1,
    imgH: 1,
    mmPerPx: 15,
    x: 140,
    y: 210,
    opacity: 0.4,
    visible: false,
    locked: true,
  };
  const first = project.variants[0];
  app.store.commit(
    project.id,
    first.id,
    first.revision,
    first.plan,
    "测试底图",
    underlay,
    0,
  );
  let editor = await openProject(project.id);
  await editor.click('.atelier-nav[data-panel="furn"]');
  await (await editor.waitForSelector("#glbFile")).uploadFile(fixture);
  await editor.waitForFunction(() =>
    Object.keys(window.__designer.CAT).some((key) => key.startsWith("model:")),
  );
  const id = await editor.evaluate(() =>
    Object.keys(window.__designer.CAT)
      .find((key) => key.startsWith("model:"))
      .slice(6),
  );
  // Picking a catalog item calls the same placement action as a library click.
  await editor.type("#libQ", "blue-tetrahedron");
  await editor.waitForSelector(".lib-list .item", { visible: true });
  const saved = page.waitForResponse(
    (r) => r.url().endsWith("/save") && r.request().postData()?.includes(id),
  );
  await editor.click(".lib-list .item");
  assert.equal((await saved).status(), 200);
  await verifyRendered(editor, id);
  pass("import, place, render and save the original blue mesh");
  const unrelatedShape = {
    id: "excluded-shape",
    name: "不属于当前设计的合成造型",
    model: JSON.stringify({ parts: [] }),
    w: 100,
    d: 100,
    h: 100,
    color: "#eeeeee",
  };
  assert.ok(
    await editor.evaluate(
      (shape) => window.houseShapes.save([shape]),
      unrelatedShape,
    ),
  );
  const oldOrigin = app.origin;
  await app.close();
  app = await startServer({ dataDir });
  assert.notEqual(app.origin, oldOrigin);
  editor = await openProject(project.id);
  await verifyRendered(editor, id);
  await page.screenshot({ path: join(root, "model-reopened.png") });
  pass("fresh origin reopens the same mesh and instance");
  assert.deepEqual(await editor.evaluate(() => window.houseShapes.items()), [
    unrelatedShape,
  ]);
  pass(
    "the reusable shape library survives a different workspace server origin",
  );

  const downloads = mkdtempSync(join(root, "export-"));
  await (
    await page.createCDPSession()
  ).send("Page.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloads,
  });
  await page.click("#export-plan");
  const planPath = join(downloads, appData().variants[0].plan.name + ".json");
  await page.waitForFunction(
    () =>
      !document.querySelector("#editor-view").getAttribute("aria-busy") ||
      document.querySelector("#editor-view").getAttribute("aria-busy") ===
        "false",
  );
  for (let i = 0; i < 120 && !existsSync(planPath); i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  const exported = JSON.parse(readFileSync(planPath, "utf8"));
  assert.equal(exported.models.length, 1);
  assert.deepEqual(
    Buffer.from(exported.models[0].b64, "base64"),
    readFileSync(fixture),
  );
  const placed = exported.plan.furniture.find((f) => f.modelId === id);
  pass("exported JSON contains the original GLB bytes");
  await editor.click("[aria-controls=atelier-advanced]");
  await editor.click("#exportMenu > button");
  await editor.click('button[data-exp="share"]');
  await editor.waitForSelector(".modal [data-ok]");
  const packageContents = await editor.$eval(".modal", (el) => el.textContent);
  assert.match(packageContents, /描图底图/);
  assert.match(packageContents, /blue-tetrahedron/);
  assert.doesNotMatch(packageContents, /不属于当前设计的合成造型/);
  await editor.click(".modal [data-ok]");
  let sharedName;
  for (let i = 0; i < 120 && !sharedName; i++) {
    sharedName = readdirSync(downloads).find((name) => name.endsWith(".html"));
    if (!sharedName) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(sharedName, "The export menu produced a standalone HTML file");
  const sharedFile = join(downloads, sharedName);
  const exportedHtml = readFileSync(sharedFile, "utf8");
  assert.match(exportedHtml, /Copyright .*ZWD11/i);
  assert.match(exportedHtml, /Permission is hereby granted/);
  assert.ok(!exportedHtml.includes(unrelatedShape.name));
  const recipient = await browser.createBrowserContext();
  try {
    const offline = await recipient.newPage();
    const requests = [];
    offline.on("pageerror", (error) => errors.push(error.message));
    await offline.setRequestInterception(true);
    offline.on("request", (request) => {
      if (
        request.resourceType() !== "document" &&
        /^(?:https?|file):/.test(request.url())
      ) {
        requests.push(request.url());
        return request.abort("internetdisconnected");
      }
      return request.continue();
    });
    await offline.goto(pathToFileURL(sharedFile).href);
    await offline.waitForFunction(
      (modelId) =>
        window.__designer?.app.plan.furniture.some(
          (item) => item.modelId === modelId,
        ),
      { timeout: 60000 },
      id,
    );
    await offline.evaluate(() => document.querySelector("#sbX")?.click());
    await offline.click('#viewSeg [data-view="3d"]');
    await verifyRendered(offline, id);
    const shared = await offline.evaluate(() => ({
      underlay: window.__designer.app.underlay,
      desktopElements: document.querySelectorAll(
        "[data-housediy-desktop],#__preset",
      ).length,
      mesh: window.__SHARED__.models[0].b64,
      library: window.__SHARED__.fmLib,
      unknownWall: window.__wallStructureLabel({
        bearing: null,
        status: "existing",
      }),
    }));
    assert.deepEqual(shared.underlay, underlay);
    assert.equal(shared.mesh, exported.models[0].b64);
    assert.equal(shared.desktopElements, 0);
    assert.equal(shared.library, undefined);
    assert.equal(shared.unknownWall, "承重待核实");
    assert.deepEqual(requests, []);
  } finally {
    await recipient.close();
  }
  pass(
    "standalone shared HTML renders the placed GLB and calibrated underlay offline without desktop resources",
  );
  await app.close();
  app = await startServer({
    dataDir: mkdtempSync(join(root, "clean-workspace-")),
  });
  await page.goto(app.url);
  await (await page.waitForSelector("#plan-file")).uploadFile(planPath);
  await ready();
  editor = await frame();
  await verifyRendered(editor, id);
  assert.deepEqual(
    appData().variants[0].plan.furniture.find((f) => f.modelId === id),
    placed,
  );
  pass("import into a clean workspace preserves geometry and placement");

  await app.close();
  app = await startServer({
    dataDir: mkdtempSync(join(root, "legacy-workspace-")),
  });
  const legacy = app.store.create({
    name: "旧模型测试",
    variants: [{ name: "旧方案", plan: exported.plan }],
  });
  editor = await openProject(legacy.id);
  await page.waitForSelector("#model-feedback button", { visible: true });
  const legacySource = await page.$eval("#designer", (el) => el.src);
  const restored = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/models/" + id) && r.request().method() === "PUT",
  );
  await (await page.$("#model-feedback input")).uploadFile(fixture);
  assert.equal((await restored).status(), 200);
  editor = await repairedFrame(legacySource);
  await verifyRendered(editor, id);
  assert.deepEqual(
    appData().variants[0].plan.furniture.find((f) => f.modelId === id),
    placed,
  );
  pass("repair a legacy missing file in place with the original ID");

  const modelsDir = join(app.store.directory, "models");
  const damagedFile = join(modelsDir, "model-" + id + ".json"),
    fragment = '{"id":';
  writeFileSync(damagedFile, fragment);
  editor = await openProject(legacy.id);
  await page.waitForSelector("#model-feedback button", { visible: true });
  assert.match(
    await page.$eval("#model-feedback", (el) => el.textContent),
    /已损坏/,
  );
  const other = Buffer.from(readFileSync(fixture)),
    colorAt = other.indexOf("0.85");
  assert.notEqual(colorAt, -1);
  other.write("0.35", colorAt, "ascii");
  const otherPath = join(downloads, "other-tetrahedron.glb");
  writeFileSync(otherPath, other);
  const repairResponse = () =>
    page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/models/" + id) &&
        r.request().method() === "PUT" &&
        JSON.parse(r.request().postData()).repair === true,
    );
  const wrong = repairResponse();
  await (await page.$("#model-feedback input")).uploadFile(otherPath);
  assert.equal((await wrong).status(), 409);
  await page.waitForFunction(
    () =>
      document.querySelector("#toast").textContent.includes("原始校验值") &&
      document.querySelector("#editor-view").getAttribute("aria-busy") ===
        "false",
  );
  assert.equal(readFileSync(damagedFile, "utf8"), fragment);
  const damagedSource = await page.$eval("#designer", (el) => el.src);
  const fixed = repairResponse();
  await (await page.$("#model-feedback input")).uploadFile(fixture);
  assert.equal((await fixed).status(), 200);
  editor = await repairedFrame(damagedSource);
  await verifyRendered(editor, id);
  const backups = readdirSync(modelsDir).filter((name) =>
    name.endsWith(".bak"),
  );
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(modelsDir, backups[0]), "utf8"), fragment);
  assert.deepEqual(
    appData().variants[0].plan.furniture.find((f) => f.modelId === id),
    placed,
  );
  await page.screenshot({ path: join(root, "model-repaired.png") });
  pass(
    "the damaged model rejects another GLB, backs up the fragment and recovers the original mesh",
  );
  assert.deepEqual(errors, []);
} finally {
  writeFileSync(
    join(root, "results.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
  await browser?.close();
  await app.close();
}
