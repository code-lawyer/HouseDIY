// Offline packaged-app acceptance; uses isolated data and never calls a model.
import puppeteer from "puppeteer-core";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  createReadStream,
} from "node:fs";
import { resolve, join, basename } from "node:path";
import { holdFileWithoutDeleteSharing } from "./electron-qa.mjs";
import { mockProvider, recognition } from "../tests/mock-provider.mjs";

const directory = resolve(process.env.HOUSEDIY_STARTUP_DIR || ".qa/packaged");
mkdirSync(directory, { recursive: true });
const data = mkdtempSync(join(directory, "data-"));
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const executable = resolve(
  process.env.HOUSEDIY_PACKAGE_PATH ||
    `release/HouseDIY-${version}-portable.exe`,
);
assert.ok(existsSync(executable), "Build the current version first");
const fixturePath = resolve(
  process.env.HOUSEDIY_PLAN_FIXTURE || "examples/demo-plan.json",
);
if (process.env.HOUSEDIY_PLAN_FIXTURE)
  assert.ok(existsSync(fixturePath), "HOUSEDIY_PLAN_FIXTURE does not exist");
const fixtureDocument = existsSync(fixturePath)
  ? JSON.parse(readFileSync(fixturePath, "utf8"))
  : null;
const fixturePlan = fixtureDocument?.plan ?? fixtureDocument;
if (existsSync(fixturePath))
  assert.ok(
    fixturePlan &&
      Array.isArray(fixturePlan.walls) &&
      Array.isArray(fixturePlan.furniture),
    "The plan fixture must contain wall and furniture arrays",
  );
const socket = createServer();
socket.listen(0, "127.0.0.1");
await once(socket, "listening");
const port = socket.address().port;
await new Promise((r) => socket.close(r));
const digest = createHash("sha256");
for await (const chunk of createReadStream(executable)) digest.update(chunk);
const results = {
  version,
  executable: basename(executable),
  sha256: digest.digest("hex"),
  sourceCommit: process.env.GITHUB_SHA || null,
  data,
  graphicsMode: process.env.HOUSEDIY_QA_HARDWARE_GPU
    ? "system-default"
    : "software",
  checks: [],
  skipped: [],
  errors: [],
  networkErrors: [],
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const pass = (name) => {
  results.checks.push(name);
  console.log("PASS " + name);
};
let browser;
let page;
let child;
let log;
let localVision;
async function capture(name) {
  const png = Buffer.from(
    await page.evaluate(() => window.qaCapturePage()),
    "base64",
  );
  assert.ok(png.length > 1000, "The native capture contains a rendered image");
  writeFileSync(join(directory, name), png);
}
try {
  log = openSync(join(directory, "app.log"), "w");
  child = spawn(executable, [], {
    windowsHide: true,
    stdio: ["ignore", log, log],
    env: {
      ...process.env,
      HOUSEDIY_DATA_DIR: data,
      HOUSEDIY_QA_PORT: String(port),
      HOUSEDIY_QA_HIDDEN: "1",
      HOUSEDIY_SOFTWARE_GPU: process.env.HOUSEDIY_QA_HARDWARE_GPU ? "" : "1",
    },
  });
  await once(child, "spawn");
  for (let i = 0; i < 75; i++) {
    try {
      browser = await puppeteer.connect({
        browserURL: "http://127.0.0.1:" + port,
        defaultViewport: null,
        protocolTimeout: 60000,
      });
      break;
    } catch {
      await pause(1000);
    }
  }
  assert.ok(browser, "Packaged app starts");
  const pages = await browser.pages();
  page = pages.find((p) => p.url().includes("127.0.0.1"));
  assert.ok(page, "Application opened through the local service");
  page.on("pageerror", (error) => results.errors.push(error.message));
  const failedRequests = [];
  page.on("requestfailed", (request) => {
    failedRequests.push(request);
  });
  await page.waitForSelector(".project-card", { timeout: 60000 });
  await page.evaluate(() => document.fonts.ready.then(() => true));
  const appearance = await page.evaluate(() => {
    const header = document.querySelector(".shell-header");
    const logo = header.querySelector("img");
    return {
      protocol: location.protocol,
      headerDisplay: getComputedStyle(header).display,
      headerHeight: header.getBoundingClientRect().height,
      fontFamily: getComputedStyle(document.body).fontFamily,
      logoWidth: logo.naturalWidth,
      projects: document.querySelectorAll(".project-card").length,
      fileGuideHidden: document.querySelector("#file-entry").hidden,
      desktopBridge: typeof window.desktop?.exportPlan,
      footer: document.querySelector("footer").textContent,
      nodeAccess: typeof window.require,
      processAccess: typeof window.process,
      paper: getComputedStyle(document.documentElement)
        .getPropertyValue("--paper")
        .trim(),
      bundledFontLoaded: [...document.fonts].some(
        (font) =>
          font.family.replace(/["']/g, "") === "HouseDIY Sans" &&
          font.status === "loaded",
      ),
    };
  });
  assert.equal(appearance.protocol, "http:");
  assert.equal(appearance.headerDisplay, "flex");
  assert.equal(appearance.headerHeight, 72);
  assert.equal(appearance.paper, "#f6f3ed");
  assert.equal(appearance.bundledFontLoaded, true);
  assert.ok(appearance.logoWidth > 0);
  assert.equal(appearance.fileGuideHidden, true);
  assert.equal(appearance.desktopBridge, "function");
  assert.ok(appearance.footer.includes(`HouseDIY ${version}`));
  assert.equal(appearance.nodeAccess, "undefined");
  assert.equal(appearance.processAccess, "undefined");
  results.appearance = appearance;
  pass("Portable startup loads the complete styled home and real project data");

  const resources = await page.evaluate(async () => {
    const paths = [
      "/style.css",
      "/logo.svg",
      "/startup.js",
      "/app.js",
      "/editor-session.js",
      "/design-rules.js",
      "/design-tokens.css",
      "/editor-theme.css",
      "/editor-workspace.js",
      "/editor-bridge.js",
      "/editor-models.js",
      "/editor-recovery.js",
      "/opening-placement.js",
      "/icons/house.svg",
      "/icons/couch.svg",
      "/icons/leaf.svg",
      "/fonts/noto-sans-sc.ttf",
    ];
    return Promise.all(
      paths.map(async (path) => {
        const response = await fetch(path);
        return {
          path,
          status: response.status,
          type: response.headers.get("content-type"),
        };
      }),
    );
  });
  assert.ok(resources.every((resource) => resource.status === 200));
  assert.match(
    resources.find((resource) => resource.path === "/style.css").type,
    /text\/css/,
  );
  results.resources = resources;
  await capture("home.png");
  pass("All startup CSS, image and JavaScript resources return successfully");

  await page.click(".project-card");
  const waitEditor = () =>
    page.waitForFunction(
      () =>
        !document.querySelector("#editor-view").hidden &&
        document.querySelector("#editor-loading").hidden &&
        document.querySelector("#editor-view").getAttribute("aria-busy") ===
          "false",
      { polling: 100, timeout: 60000 },
    );
  const goHome = async () => {
    const homeButtonEnabled = () =>
      !document.querySelector("#home-button").disabled;
    await page.waitForFunction(homeButtonEnabled, { polling: 100 });
    await page.click("#home-button");
    await page.waitForFunction(
      () =>
        !document.querySelector("#home-view").hidden &&
        !document.querySelector("#home-button").disabled,
      { polling: 100 },
    );
  };
  await waitEditor();
  let frame = await (await page.$("#designer")).contentFrame();
  await frame.waitForFunction(
    () =>
      window.__designer?.S3.ready &&
      !window.__designer.app.transitioning &&
      !window.__designer.S3.isAnimating(),
    { timeout: 60000 },
  );
  await page.waitForFunction(
    () => document.querySelector("#save-status").textContent === "已保存",
  );
  const geometry = await frame.evaluate(() => ({
    furniture: window.__designer.app.plan.furniture.length,
    rooms: window.__designer.app.rooms.regions.length,
    ready: window.__designer.S3.ready,
  }));
  assert.ok(geometry.ready && geometry.furniture > 0 && geometry.rooms > 0);
  assert.equal(
    await page.$eval("#chat-panel", (element) => element.hidden),
    false,
  );
  results.geometry = geometry;
  results.webgl = await frame.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return { available: false };
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const result = {
      available: true,
      renderer: debug
        ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER),
    };
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return result;
  });
  await capture("editor.png");
  pass(
    "Opening a project retains the original 3D editor and the AI conversation panel",
  );

  const originalFurniture = await frame.evaluate(() => {
    const d = window.__designer;
    const item = d.app.plan.furniture[0];
    d.select("furn", item.id);
    return structuredClone(item);
  });
  const swatchColor =
    originalFurniture.color === "#c9bda6" ? "#e7dcc7" : "#c9bda6";
  const nextNote = () =>
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/note") && response.status() === 200,
    );
  const applyColor = async () => {
    await page.waitForSelector("#selection-details", { visible: true });
    const noted = nextNote();
    await page.click(`[data-color="${swatchColor}"]`);
    await noted;
    await frame.waitForFunction(
      ({ id, color }) =>
        window.__designer.app.plan.furniture.find((f) => f.id === id)?.color ===
        color,
      {},
      { id: originalFurniture.id, color: swatchColor },
    );
    await page.waitForFunction(
      (color) =>
        document
          .querySelector(`[data-color="${color}"]`)
          .getAttribute("aria-pressed") === "true",
      {},
      swatchColor,
    );
    await waitEditor();
  };
  await applyColor();
  await capture("furniture-color.png");
  pass(
    "Packaged furniture color controls update the renderer and save successfully",
  );

  const notesBeforeRepeat = await page.$$eval(
    "#messages .action",
    (items) => items.length,
  );
  await page.click(`[data-color="${swatchColor}"]`);
  await page.waitForFunction(() =>
    document.querySelector("#toast").textContent.includes("未作修改"),
  );
  assert.equal(
    await page.$$eval("#messages .action", (items) => items.length),
    notesBeforeRepeat,
  );
  const undoRecorded = nextNote();
  await page.click("#undo-ai");
  await undoRecorded;
  await waitEditor();
  await frame.waitForFunction(
    ({ id, color }) =>
      window.__designer.app.plan.furniture.find((f) => f.id === id)?.color ===
      color,
    {},
    { id: originalFurniture.id, color: originalFurniture.color },
  );
  pass(
    "Repeated colors create no false action and undo restores the previous furniture color",
  );

  await frame.evaluate(
    (id) => window.__designer.select("furn", id),
    originalFurniture.id,
  );
  await applyColor();
  await goHome();
  await page.waitForSelector(".project-card", { visible: true });
  await page.click(".project-card");
  await waitEditor();
  frame = await (await page.$("#designer")).contentFrame();
  assert.equal(
    await frame.evaluate(
      (id) =>
        window.__designer.app.plan.furniture.find((f) => f.id === id)?.color,
      originalFurniture.id,
    ),
    swatchColor,
  );
  pass(
    "The portable application reopens the saved furniture color from isolated disk data",
  );

  await page.click("#settings-button");
  await page.waitForSelector("#settings-dialog[open]");
  await page.select("#model-provider", "api");
  assert.equal(
    await page.$eval("#api-settings", (element) => element.hidden),
    false,
  );
  await capture("settings.png");
  await page.keyboard.press("Escape");
  assert.equal(
    await page.$eval("#settings-dialog", (element) => element.open),
    false,
  );
  pass(
    "Packaged model settings open and close without changing saved credentials",
  );

  if (fixturePlan) {
    await goHome();
    await (await page.$("#plan-file")).uploadFile(fixturePath);
    await waitEditor();
    frame = await (await page.$("#designer")).contentFrame();
    const design = await frame.evaluate(() => ({
      walls: window.__designer.app.plan.walls.length,
      furniture: window.__designer.app.plan.furniture.length,
    }));
    assert.equal(design.walls, fixturePlan.walls.length);
    assert.equal(design.furniture, fixturePlan.furniture.length);
    results.existingDesign = { fixture: fixturePath, ...design };
    await capture("existing-design.png");
    pass(
      `The imported fixture renders with all ${design.walls} walls and ${design.furniture} furniture objects`,
    );
  } else {
    const reason =
      "Plan import skipped: no local fixture or HOUSEDIY_PLAN_FIXTURE";
    results.skipped.push(reason);
    console.log("SKIP " + reason);
  }
  const projectId = await frame.evaluate(() => window.__HOUSEDIY__.projectId);
  const readProject = () =>
    page.evaluate(
      async (id) => (await fetch(`/api/projects/${id}`)).json(),
      projectId,
    );
  const beforeTrash = await readProject();
  await page.click("#delete-project");
  await page.waitForSelector("#delete-dialog[open]");
  await page.click("#confirm-delete");
  await page.waitForFunction(
    () =>
      !document.querySelector("#home-view").hidden &&
      !document.querySelector("#delete-dialog").open,
  );
  await page.click("#open-trash");
  const row = `.trash-row[data-project-id="${projectId}"]`;
  await page.waitForSelector(row);
  await capture("recycle-bin.png");
  await page.click(row + " .trash-restore");
  const card = `.project-entry[data-project-id="${projectId}"] .project-card`;
  await page.waitForSelector(card);
  const afterRestore = await readProject();
  assert.deepEqual(afterRestore.variants, beforeTrash.variants);
  assert.deepEqual(
    afterRestore.designPreferences,
    beforeTrash.designPreferences,
  );
  assert.equal(afterRestore.lifecycle, beforeTrash.lifecycle + 2);
  await page.click('[data-close="trash-dialog"]');
  await page.click(card);
  await waitEditor();
  pass(
    "Packaged delete and restore preserve every variant and reopen the project",
  );
  localVision = await mockProvider();
  await page.evaluate(async (url) => {
    const response = await fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "api",
        baseUrl: url,
        model: "fixture",
        visionModel: "fixture",
      }),
    });
    if (!response.ok)
      throw new Error("Cannot configure the isolated fixture provider");
  }, localVision.url);
  const imageFile = join(directory, "recovery-plan.png");
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 600;
    canvas.height = 450;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 600, 450);
    ctx.lineWidth = 10;
    ctx.strokeRect(20, 20, 560, 410);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  writeFileSync(imageFile, Buffer.from(png, "base64"));
  // DevTools sometimes reports a finite SSE request as aborted. Independently
  // read its entire body, then bind the terminal result to the opened project.
  await page.evaluate(() => {
    const fetchOriginal = window.fetch;
    window.fetch = async function (resource, init) {
      const response = await fetchOriginal.call(this, resource, init);
      if (resource === "/api/generate")
        window.__qaGenerationBody = response.clone().text();
      return response;
    };
  });
  const completedGenerations = new Map();
  const generationResponse = () =>
    page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/generate",
    );
  async function verifyGeneration(response, editor) {
    assert.equal(response.status(), 200);
    const terminal = (await page.evaluate(() => window.__qaGenerationBody))
      .split("\n\n")
      .filter((event) => event.startsWith("data: "))
      .map((event) => JSON.parse(event.slice(6)))
      .at(-1);
    assert.equal(terminal.type, "result");
    assert.equal(
      terminal.projectId,
      await editor.evaluate(() => window.__HOUSEDIY__.projectId),
    );
    completedGenerations.set(response.request(), terminal);
  }
  async function uploadRecoveryImage(action = "#generate-button") {
    await goHome();
    await page.waitForSelector("#new-project", { visible: true });
    await page.click("#new-project");
    await (await page.$("#floorplan-file")).uploadFile(imageFile);
    await page.waitForSelector("#image-preview", { visible: true });
    await page.select("#scheme-count", "1");
    const generated = generationResponse();
    await page.click(action);
    await waitEditor();
    const editor = await (await page.$("#designer")).contentFrame();
    await verifyGeneration(await generated, editor);
    return editor;
  }
  const partial = structuredClone(recognition);
  partial.openings.push({
    type: "door",
    wall: 99,
    width: 900,
    center: [300, 430],
  });
  partial.schemes[0].furniture = [{ key: "counter", at: [200, 54.4] }];
  localVision.enqueueRecognition(partial, partial);
  frame = await uploadRecoveryImage();
  await frame.waitForFunction(
    () => window.__designer?.app.view === "3d" && window.__designer.S3.ready,
  );
  assert.deepEqual(
    await frame.evaluate(() => {
      const p = window.__designer.app.plan;
      return [p.walls.length, p.openings.length, p.pendingOpenings.length];
    }),
    [4, 1, 1],
  );
  await page.click("#locate-layout-issues");
  await page.waitForFunction(() =>
    document
      .querySelector("#messages .message:last-child")
      ?.textContent.includes("56 mm"),
  );
  assert.equal(
    await page.$$eval(
      "#messages .message:last-child li",
      (rows) => rows.filter((r) => /嵌入.*56\s*mm/.test(r.textContent)).length,
    ),
    1,
  );
  await page.click("#pending-list button");
  await page.waitForSelector("#repair-wall", { visible: true });
  const wall = await frame.evaluate(
    () => window.__designer.app.plan.walls[2].id,
  );
  await page.select("#repair-wall", wall);
  await page.click('#repair-form [type="submit"]');
  await page.waitForFunction(
    () =>
      document.querySelector("#pending-openings").hidden &&
      document.querySelector("#editor-loading").hidden,
  );
  assert.equal(
    await frame.evaluate(() => window.__designer.app.plan.openings.at(-1).wall),
    wall,
  );
  pass(
    "Packaged 3D opens with the 56 mm cabinet clash and an orphan door that can be placed on its selected wall",
  );
  localVision.enqueueRecognition({ walls: [] }, { walls: [] });
  frame = await uploadRecoveryImage();
  assert.deepEqual(
    await frame.evaluate(() => {
      const d = window.__designer.app;
      return [d.view, d.underlay.visible, d.plan.walls.length];
    }),
    ["2d", true, 0],
  );
  const imageId = await frame.evaluate(() => window.__HOUSEDIY__.projectId);
  const retryResponse = generationResponse();
  await page.click("#retry-source");
  await page.waitForFunction(
    () =>
      document.querySelector("#trace-source").hidden &&
      !document.querySelector("#retry-dialog").open,
  );
  await waitEditor();
  frame = await (await page.$("#designer")).contentFrame();
  assert.deepEqual(
    await frame.evaluate(() => [
      window.__HOUSEDIY__.projectId,
      window.__designer.app.view,
      window.__designer.app.plan.walls.length,
    ]),
    [imageId, "3d", 4],
  );
  await verifyGeneration(await retryResponse, frame);
  assert.match(
    await page.$eval("#toast", (e) => e.textContent),
    /设计方案已生成/,
  );
  const persistedWallCount = await page.evaluate(
    async (id) =>
      (await (await fetch("/api/projects/" + id)).json()).variants[0].plan.walls
        .length,
    imageId,
  );
  assert.equal(persistedWallCount, 4);
  pass(
    "The packaged app preserves an unrecognized image as a traceable 2D project and regenerates 3D under the same project ID",
  );
  const beforeTrace = localVision.requests.length;
  frame = await uploadRecoveryImage("#manual-import");
  const canvas = await frame.$("#c2d");
  const box = await canvas.boundingBox();
  const originalScale = await frame.evaluate(
    () => window.__designer.app.underlay.mmPerPx,
  );
  await page.click("#calibrate-source");
  await frame.waitForFunction(() => window.__designer.app.tool === "calibrate");
  const clickAt = (x, y) =>
    page.mouse.click(box.x + x * box.width, box.y + y * box.height);
  await clickAt(0.32, 0.45);
  await clickAt(0.68, 0.45);
  await frame.waitForSelector(".modal-box input", { visible: true });
  await page.keyboard.type("3800");
  await page.keyboard.press("Enter");
  await frame.waitForFunction(
    (prev) => window.__designer.app.underlay.mmPerPx !== prev,
    {},
    originalScale,
  );
  await page.click("#trace-wall");
  await frame.waitForFunction(() => window.__designer.app.tool === "wall");
  await clickAt(0.32, 0.55);
  await clickAt(0.68, 0.55);
  await page.keyboard.press("Escape");
  await frame.waitForFunction(
    () => window.__designer.app.plan.walls.length === 1,
  );
  const traced = await frame.evaluate(() => window.__HOUSEDIY__.projectId);
  await goHome();
  const tracedCard = `.project-entry[data-project-id="${traced}"] .project-card`;
  await page.waitForSelector(tracedCard, { visible: true });
  await page.click(tracedCard);
  await waitEditor();
  frame = await (await page.$("#designer")).contentFrame();
  assert.deepEqual(
    await frame.evaluate(() => [
      window.__designer.app.view,
      window.__designer.S3.ready,
      window.__designer.app.plan.walls.length,
    ]),
    ["3d", true, 1],
  );
  assert.equal(localVision.requests.length, beforeTrace);
  pass(
    "Two-point calibration and manual tracing in the Windows app produce a saved 3D wall without a model call",
  );

  const recycleModel = readFileSync(
    new URL("../tests/fixtures/blue-tetrahedron.glb", import.meta.url),
  );
  const exclusiveModel = "trash-qa-exclusive";
  const sharedModel = "trash-qa-shared";
  const { trashFixtures, sharedProject } = await page.evaluate(
    async (plan, b64, exclusive, shared) => {
      const withModels = (...ids) => ({
        ...plan,
        furniture: [
          ...plan.furniture,
          ...ids.map((id) => ({
            id,
            key: "model:" + id,
            modelId: id,
            name: id,
            x: 2500,
            y: 2500,
            w: 900,
            d: 1000,
            h: 700,
          })),
        ],
      });
      async function createFixture(name, document = plan) {
        const response = await fetch("/api/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, plan: document }),
        });
        if (!response.ok)
          throw new Error("Cannot create a recycle-bin QA fixture: " + name);
        return (await response.json()).id;
      }
      const models = [exclusive, shared].map((id) => ({
        id,
        name: id,
        w: 900,
        d: 1000,
        h: 700,
        b64,
      }));
      const trashFixtures = [
        await createFixture("回收站单项验收", {
          plan: withModels(exclusive, shared),
          models,
        }),
        await createFixture("回收站批量验收一"),
        await createFixture("回收站批量验收二"),
        await createFixture("回收站乱序验收"),
      ];
      const sharedProject = await createFixture(
        "保留共享 GLB",
        withModels(shared),
      );
      return { trashFixtures, sharedProject };
    },
    beforeTrash.variants[0].plan,
    recycleModel.toString("base64"),
    exclusiveModel,
    sharedModel,
  );
  const [singleId, damagedId, lockedId, restoreId] = trashFixtures;
  const projectFile = (id) => join(data, "workspace", "projects", id + ".json");
  const modelFile = (id) =>
    join(data, "workspace", "models", "model-" + id + ".json");
  const trashRow = (id) => `.trash-row[data-project-id="${id}"]`;
  await goHome();
  for (const id of trashFixtures) {
    const button = `.project-entry[data-project-id="${id}"] .project-delete`;
    await page.waitForSelector(button, { visible: true });
    await page.click(button);
    await page.click("#confirm-delete");
    await page.waitForSelector("#delete-dialog[open]", { hidden: true });
  }
  await page.click("#open-trash");
  const singlePurge = trashRow(singleId) + " .trash-purge";
  await page.waitForSelector(singlePurge);
  assert.equal((await page.$$(".trash-row")).length, 4);

  await page.click(singlePurge);
  await page.waitForSelector("#purge-dialog[open]");
  assert.match(
    await page.$eval("#purge-description", (el) => el.textContent),
    /回收站单项验收/,
  );
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    "cancel-purge",
  );
  await capture("permanent-delete-confirmation.png");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#purge-dialog[open]", { hidden: true });
  assert.ok(existsSync(projectFile(singleId)));
  assert.ok(existsSync(modelFile(exclusiveModel)));

  const staleCatalog = await page.evaluate(async () =>
    (await fetch("/api/trash?diagnostics=1")).json(),
  );
  staleCatalog.projects = staleCatalog.projects.filter(
    ({ id }) => id !== restoreId,
  );
  const isTrashRefresh = (request) =>
    new URL(request.url()).pathname === "/api/trash";
  let holdNext = true;
  const holdRestoreRefresh = (request) => {
    if (holdNext && isTrashRefresh(request)) {
      holdNext = false;
      return;
    }
    return request.continue();
  };
  await page.setRequestInterception(true);
  page.on("request", holdRestoreRefresh);
  try {
    const [olderRefresh] = await Promise.all([
      page.waitForRequest(isTrashRefresh, { timeout: 10000 }),
      page.click(trashRow(restoreId) + " .trash-restore"),
    ]);
    await page.click(singlePurge);
    await page.click("#confirm-purge");
    await page.waitForSelector("#purge-dialog[open]", { hidden: true });
    await page.waitForSelector(singlePurge, { hidden: true });
    await olderRefresh.respond({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(staleCatalog),
    });
    await page.waitForSelector(
      `.project-entry[data-project-id="${restoreId}"]`,
    );
    assert.equal(await page.$(singlePurge), null);
  } finally {
    page.off("request", holdRestoreRefresh);
    await page.setRequestInterception(false);
  }
  assert.equal(existsSync(projectFile(singleId)), false);
  assert.equal((await page.$$(".trash-row")).length, 2);
  pass(
    "Single permanent delete defaults to Cancel and removes only the confirmed project file",
  );
  pass("A delayed restore refresh cannot resurrect a permanently deleted row");
  assert.equal(existsSync(modelFile(exclusiveModel)), false);
  const sharedBytes = JSON.parse(
    readFileSync(modelFile(sharedModel), "utf8"),
  ).b64;
  assert.deepEqual(Buffer.from(sharedBytes, "base64"), recycleModel);
  assert.ok(existsSync(projectFile(sharedProject)));
  pass(
    "Permanent project deletion removes its orphaned GLB and preserves the shared GLB bytes",
  );

  await page.click("#empty-trash");
  await page.waitForSelector("#purge-dialog[open]");
  assert.match(
    await page.$eval("#purge-description", (el) => el.textContent),
    /2 个项目/,
  );
  await capture("empty-trash-confirmation.png");
  await page.click("#cancel-purge");
  await page.waitForSelector("#purge-dialog[open]", { hidden: true });
  assert.ok([damagedId, lockedId].every((id) => existsSync(projectFile(id))));
  assert.equal((await page.$$(".trash-row")).length, 2);
  await page.click("#close-trash");
  const corrupt = JSON.parse(readFileSync(projectFile(damagedId), "utf8"));
  corrupt.variants[0].plan = null;
  writeFileSync(projectFile(damagedId), JSON.stringify(corrupt));
  const uncertainId = "0000000000000000";
  const uncertainFile = projectFile(uncertainId);
  assert.equal(existsSync(uncertainFile), false);
  writeFileSync(uncertainFile, "{");
  await page.click("#open-trash");
  await page.waitForSelector(trashRow(damagedId) + " .trash-purge");
  assert.equal(await page.$(trashRow(damagedId) + " .trash-restore"), null);
  assert.match(
    await page.$eval(trashRow(damagedId), (el) => el.textContent),
    /项目文件损坏/,
  );
  await page.waitForSelector("#trash-diagnostics:not([hidden])");
  assert.equal(await page.$(trashRow(uncertainId)), null);
  const originalLocked = readFileSync(projectFile(lockedId));
  const releaseFileLock = await holdFileWithoutDeleteSharing(
    projectFile(lockedId),
  );
  try {
    await page.click("#empty-trash");
    assert.match(
      await page.$eval("#purge-description", (el) => el.textContent),
      /2 个项目/,
    );
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => new URL(r.url()).pathname === "/api/trash/purge",
      ),
      page.click("#confirm-purge"),
    ]);
    assert.deepEqual(await response.json(), {
      deletedCount: 1,
      failedCount: 1,
    });
    await page.waitForSelector("#purge-dialog[open]", { hidden: true });
    await page.waitForSelector(trashRow(damagedId), { hidden: true });
    assert.equal(existsSync(projectFile(damagedId)), false);
    assert.equal(readFileSync(uncertainFile, "utf8"), "{");
    assert.deepEqual(readFileSync(projectFile(lockedId)), originalLocked);
    assert.match(
      await page.$eval("#trash-feedback", (el) => el.textContent),
      /1 个项目未能删除/,
    );
    assert.equal((await page.$$(".trash-row")).length, 1);
  } finally {
    await releaseFileLock();
  }
  pass(
    "Empty Trash can remove a known damaged project and preserves the unclassifiable file",
  );

  await page.click("#empty-trash");
  assert.match(
    await page.$eval("#purge-description", (el) => el.textContent),
    /1 个项目/,
  );
  await page.click("#confirm-purge");
  await page.waitForSelector("#purge-dialog[open]", { hidden: true });
  await page.waitForSelector("#trash-list .empty-projects");
  assert.match(
    await page.$eval("#trash-list .empty-projects", (el) => el.textContent),
    /没有可确认在回收站的项目/,
  );
  assert.equal(await page.$eval("#empty-trash", (el) => el.disabled), true);
  assert.ok(
    [singleId, damagedId, lockedId].every((id) => !existsSync(projectFile(id))),
  );
  assert.equal(readFileSync(uncertainFile, "utf8"), "{");
  assert.ok(existsSync(projectFile(projectId)));
  pass(
    "Empty Trash reports a partial failure, retries the unlocked project and preserves active projects",
  );

  assert.deepEqual(results.errors, []);
  for (const request of failedRequests) {
    const error = request.failure()?.errorText;
    const completed = completedGenerations.get(request);
    if (completed && error === "net::ERR_ABORTED") {
      (results.completedGenerationTransport ??= []).push({
        projectId: completed.projectId,
        draftStatus: completed.draftStatus,
        devTools: error,
      });
    } else
      results.networkErrors.push({
        path: new URL(request.url()).pathname,
        error,
      });
  }
  assert.deepEqual(results.networkErrors, []);
} catch (error) {
  results.error = error.message;
  throw error;
} finally {
  if (browser?.connected) {
    await page?.evaluate(() => window.desktop.closeReady()).catch(() => {});
    await browser.disconnect();
  }
  child?.kill();
  await localVision?.close();
  if (log !== undefined) closeSync(log);
  writeFileSync(
    join(directory, "results.json"),
    JSON.stringify(results, null, 2),
  );
}
console.log(
  JSON.stringify({
    passed: true,
    checks: results.checks.length,
    skipped: results.skipped,
    directory,
  }),
);
