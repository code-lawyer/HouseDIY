// Offline packaged-app acceptance; uses isolated data and never calls a model.
import puppeteer from "puppeteer-core";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
} from "node:fs";
import { resolve, join } from "node:path";
import { captureNativeWindow } from "./electron-qa.mjs";

const directory = resolve(process.env.HOUSEDIY_STARTUP_DIR || ".qa/packaged");
mkdirSync(directory, { recursive: true });
const data = mkdtempSync(join(directory, "data-"));
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const executable = resolve(`release/HouseDIY-${version}-portable.exe`);
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
const inspectorSocket = createServer();
inspectorSocket.listen(0, "127.0.0.1");
await once(inspectorSocket, "listening");
const inspectorPort = inspectorSocket.address().port;
await new Promise((r) => inspectorSocket.close(r));
const results = {
  version,
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
let debuggerSocket;
let child;
let log;
const capture = (name) =>
  captureNativeWindow(debuggerSocket, join(directory, name));
try {
  log = openSync(join(directory, "app.log"), "w");
  child = spawn(executable, ["--inspect=" + inspectorPort], {
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
  const endpoints = await (
    await fetch("http://127.0.0.1:" + inspectorPort + "/json/list")
  ).json();
  debuggerSocket = new WebSocket(endpoints[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    debuggerSocket.onopen = resolve;
    debuggerSocket.onerror = reject;
  });
  const pages = await browser.pages();
  page = pages.find((p) => p.url().includes("127.0.0.1"));
  assert.ok(page, "Application opened through the local service");
  page.on("pageerror", (error) => results.errors.push(error.message));
  page.on("requestfailed", (request) => {
    results.networkErrors.push({
      path: new URL(request.url()).pathname,
      error: request.failure()?.errorText,
    });
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
      "/design-tokens.css",
      "/editor-theme.css",
      "/editor-workspace.js",
      "/editor-bridge.js",
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
        document.querySelector("#editor-loading").hidden,
      { polling: 100, timeout: 60000 },
    );
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
  await page.click("#home-button");
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
    await page.click("#home-button");
    await page.waitForFunction(
      () => !document.querySelector("#home-view").hidden,
      { polling: 100 },
    );
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
  assert.deepEqual(results.errors, []);
  assert.deepEqual(results.networkErrors, []);
} catch (error) {
  results.error = error.message;
  throw error;
} finally {
  debuggerSocket?.close();
  if (browser?.connected) {
    await page?.evaluate(() => window.desktop.closeReady()).catch(() => {});
    await browser.disconnect();
  }
  child?.kill();
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
