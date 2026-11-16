import puppeteer from "puppeteer-core";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { startServer } from "../src/server.mjs";
import { demoPlan, applyOperations } from "../src/model.mjs";
import { mockProvider } from "../tests/mock-provider.mjs";

const directory = resolve(
  process.env.HOUSEDIY_REGRESSION_DIR || ".qa/regressions",
);
mkdirSync(directory, { recursive: true });
const mock = await mockProvider();
const app = await startServer({
  dataDir: mkdtempSync(join(directory, "data-")),
});
await app.store.setSettings({
  provider: "api",
  baseUrl: mock.url,
  model: "test",
  visionModel: "vision",
});
const project = app.store.get(app.store.list()[0].id);
const first = project.variants[0];
const second = app.store.cloneVariant(project.id, first.id, "方案 B");
const partitionPlan = applyOperations(demoPlan(), [
  { op: "add_wall", a: [200, 2000], b: [5800, 2000], t: 100 },
]).plan;
partitionPlan.furniture = [];
const partition = partitionPlan.walls.find((w) => w.status === "new");
partition.status = "existing";
const wallProject = app.store.create({
  name: "隔墙改造验收",
  variants: [{ name: "原始隔墙", plan: partitionPlan }],
});
const checks = [],
  errors = [],
  measurements = {};
let browser;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
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
      "--disable-background-timer-throttling",
    ],
    defaultViewport: { width: 1600, height: 980 },
    protocolTimeout: 60000,
  });
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setRequestInterception(true);
  let holdSave = false,
    held,
    onHeld;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/codex/status"))
      return request.respond({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          available: true,
          loggedIn: true,
          message: "已登录，可以直接使用",
          version: "界面验收模拟状态",
          account: "",
        }),
      });
    if (request.url().endsWith("/save") && holdSave) {
      holdSave = false;
      held = request;
      onHeld();
      return;
    }
    return request.continue();
  });
  const shot = (name) =>
    page.screenshot({ path: join(directory, name + ".png") });
  const ready = async () => {
    await page.waitForFunction(
      () =>
        !document.querySelector("#editor-view").hidden &&
        document.querySelector("#editor-loading").hidden,
    );
    const frame = await (await page.$("#designer")).contentFrame();
    await frame.waitForFunction(
      () =>
        window.__designer?.S3.ready &&
        !window.__designer.app.transitioning &&
        !window.__designer.S3.isAnimating(),
    );
    await page.waitForFunction(
      () => document.querySelector("#save-status").textContent === "已保存",
    );
    return frame;
  };
  const open = async (name) => {
    await page.waitForSelector(".project-card");
    await page.evaluate(
      (name) =>
        [...document.querySelectorAll(".project-card")]
          .find((e) => e.textContent.includes(name))
          .click(),
      name,
    );
    return ready();
  };
  const home = async () => {
    await page.click("#home-button");
    await page.waitForFunction(
      () => !document.querySelector("#home-view").hidden,
    );
    await page.waitForSelector(".project-card");
  };
  const send = async (text) => {
    await page.type("#chat-input", text);
    await page.click("#send-chat");
  };
  const chatDone = () =>
    page.waitForFunction(() => !document.querySelector("#send-chat").hidden);
  const pose = (frame) =>
    frame.evaluate(() => {
      const d = window.__designer,
        { camera, controls } = d.S3.sceneRefs();
      const delta = camera.position.clone().sub(controls.target);
      return {
        phi: Math.atan2(Math.hypot(delta.x, delta.z), delta.y),
        position: camera.position.toArray(),
      };
    });
  await page.goto(app.url);
  await page.waitForSelector(".project-card");
  await shot("home-1600");
  let frame = await open("日光客厅");
  const initialPose = await pose(frame);
  await pause(2100);
  const stablePose = await pose(frame);
  assert.ok(Math.abs(stablePose.phi - 0.45) < 0.01, JSON.stringify(stablePose));
  assert.ok(
    stablePose.position.every(
      (n, i) => Math.abs(n - initialPose.position[i]) < 0.01,
    ),
  );
  assert.equal(await frame.evaluate(() => window.__designer.undo()), false);
  measurements.pose = stablePose;
  pass(
    "Initial 3D bird's-eye pose remains stable after upstream transition; undo baseline is isolated",
  );

  // Delay a navigation save and simulate a queued edit inside the old frame.
  let resolveHeld;
  const saving = new Promise((r) => {
    resolveHeld = r;
  });
  onHeld = resolveHeld;
  holdSave = true;
  const beforeX = await frame.evaluate(() => {
    const d = window.__designer;
    d.app.plan.furniture[0].x += 100;
    d.commit();
    return d.app.plan.furniture[0].x;
  });
  await page.select("#variant-select", second.id);
  await Promise.race([
    saving,
    pause(15000).then(() => {
      throw new Error("Save interception timed out");
    }),
  ]);
  assert.equal(await page.$eval("#designer", (e) => e.inert), true);
  assert.equal(await page.$eval("#editor-loading", (e) => e.hidden), false);
  const finalX = await frame.evaluate(() => {
    const d = window.__designer;
    d.app.plan.furniture[0].x += 200;
    d.commit();
    return d.app.plan.furniture[0].x;
  });
  await held.continue();
  frame = await ready();
  await frame.waitForFunction(
    () => window.__designer.app.plan.name === "方案 B",
  );
  assert.equal(
    app.store.variant(project.id, first.id).v.plan.furniture[0].x,
    finalX,
  );
  measurements.navigation = {
    firstSnapshotX: beforeX,
    finalVisibleX: finalX,
    savedX: finalX,
  };
  pass(
    "Navigation blocks new UI input and drains edits queued during an in-flight save",
  );

  // Hold the next save until navigation has joined it. Otherwise autosave can
  // consume the one-shot failure before the click, and navigation validly retries.
  const failingSave = new Promise((resolve) => {
    onHeld = resolve;
  });
  holdSave = true;
  const retryX = await frame.evaluate(() => {
    const d = window.__designer;
    d.app.plan.furniture[0].x += 50;
    d.commit();
    return d.app.plan.furniture[0].x;
  });
  await page.click("#home-button");
  await Promise.race([
    failingSave,
    pause(15000).then(() => {
      throw new Error("Failed-save interception timed out");
    }),
  ]);
  assert.equal(await page.$eval("#designer", (e) => e.inert), true);
  await held.respond({
    status: 500,
    contentType: "application/json",
    body: '{"error":"测试：磁盘暂时不可用"}',
  });
  await page.waitForFunction(() =>
    document.querySelector("#toast").textContent.includes("磁盘暂时不可用"),
  );
  assert.equal(await page.$eval("#editor-view", (e) => e.hidden), false);
  assert.equal(await page.$eval("#designer", (e) => e.inert), false);
  await page.click("#save-status");
  await page.waitForFunction(
    () => document.querySelector("#save-status").textContent === "已保存",
  );
  assert.equal(
    app.store.variant(project.id, second.id).v.plan.furniture[0].x,
    retryX,
  );
  pass(
    "Failed navigation save keeps the current editor and allows a successful retry",
  );

  const furnitureBeforeColor = await frame.evaluate(() => {
    const d = window.__designer;
    d.select("furn", d.app.plan.furniture[0].id);
    return structuredClone(d.app.plan.furniture[0]);
  });
  await page.waitForSelector("#selection-details", { visible: true });
  const swatchColor = "#c9bda6";
  assert.notEqual(furnitureBeforeColor.color, swatchColor);
  const nextNote = () =>
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/variants/${second.id}/note`) &&
        response.status() === 200,
    );
  const applySwatch = async () => {
    const noted = nextNote();
    await page.click(`[data-color="${swatchColor}"]`);
    await noted;
    assert.equal(
      app.store.variant(project.id, second.id).v.plan.furniture[0].color,
      swatchColor,
    );
  };
  await applySwatch();
  const noteCount = app.store.variant(project.id, second.id).v.messages.length;
  await page.click(`[data-color="${swatchColor}"]`);
  await page.waitForFunction(() =>
    document.querySelector("#toast").textContent.includes("未作修改"),
  );
  assert.equal(
    app.store.variant(project.id, second.id).v.messages.length,
    noteCount,
  );
  const undoNoted = nextNote();
  await page.click("#undo-ai");
  await undoNoted;
  await frame.waitForFunction(
    (color) => window.__designer.app.plan.furniture[0].color === color,
    {},
    furnitureBeforeColor.color,
  );
  assert.equal(
    app.store.variant(project.id, second.id).v.plan.furniture[0].color,
    furnitureBeforeColor.color,
  );

  // A stale shell selection must never recolor a different object.
  const beforeStaleColor = await frame.evaluate(() => {
    const d = window.__designer;
    d.select("furn", d.app.plan.furniture[1].id);
    return JSON.stringify(d.app.plan);
  });
  const staleReply = await page.evaluate(
    ({ id, color }) =>
      new Promise((resolve, reject) => {
        const editor = document.querySelector("#designer").contentWindow;
        const requestId = "qa-stale-color";
        const timer = setTimeout(() => {
          removeEventListener("message", receive);
          reject(new Error("Color reply timed out"));
        }, 10000);
        const receive = (event) => {
          if (
            event.origin !== location.origin ||
            event.source !== editor ||
            event.data?.source !== "housediy-editor" ||
            event.data?.requestId !== requestId
          )
            return;
          clearTimeout(timer);
          removeEventListener("message", receive);
          resolve(event.data);
        };
        addEventListener("message", receive);
        editor.postMessage(
          {
            source: "housediy-shell",
            requestId,
            action: "color",
            payload: { id, color },
          },
          location.origin,
        );
      }),
    { id: furnitureBeforeColor.id, color: swatchColor },
  );
  assert.match(staleReply.error, /选中的家具已变化/);
  assert.equal(
    await frame.evaluate(() => JSON.stringify(window.__designer.app.plan)),
    beforeStaleColor,
  );
  await frame.evaluate(
    (id) => window.__designer.select("furn", id),
    furnitureBeforeColor.id,
  );
  // Wait for the selection polling bridge to refresh the shell before clicking.
  await page.waitForFunction(
    (name) =>
      document.querySelector("#selection-name").textContent.includes(name),
    {},
    furnitureBeforeColor.name,
  );
  await applySwatch();
  await page.select("#variant-select", first.id);
  frame = await ready();
  await page.select("#variant-select", second.id);
  frame = await ready();
  assert.equal(
    await frame.evaluate(() => window.__designer.app.plan.furniture[0].color),
    swatchColor,
  );
  pass(
    "Furniture swatches persist across reopening, undo correctly, skip unchanged colors and reject stale selections",
  );

  const color = await frame.evaluate(
    () => window.__designer.app.plan.furniture[0].color,
  );
  await send("把沙发换成暖米色");
  await chatDone();
  await page.waitForFunction(
    () => document.querySelector("#editor-loading").hidden,
  );
  assert.equal(
    await frame.evaluate(() => window.__designer.app.plan.furniture[0].color),
    "#d4c5af",
  );
  await page.click("#undo-ai");
  await page.waitForFunction(
    () => document.querySelector("#editor-loading").hidden,
  );
  await frame.waitForFunction(
    (c) => window.__designer.app.plan.furniture[0].color === c,
    {},
    color,
  );
  pass("AI furniture edit and undo both persist through the session queue");

  const heldResponse = mock.holdNextResponse();
  try {
    await send("把沙发换成暖米色");
    await Promise.race([
      heldResponse.received,
      pause(15000).then(() => {
        throw new Error("Model request was not received");
      }),
    ]);
    await page.waitForSelector("#stop-chat", { visible: true });
    await page.click("#stop-chat");
    await chatDone();
    await page.waitForFunction(() =>
      document
        .querySelector("#messages")
        .textContent.includes("已停止，尚未应用的修改不会写入方案"),
    );
  } finally {
    heldResponse.release();
  }
  await heldResponse.completed;
  assert.equal(
    await frame.evaluate(() => window.__designer.app.plan.furniture[0].color),
    color,
  );
  pass(
    "Stopping an AI request prevents unapplied changes from reaching the design",
  );

  await frame.evaluate(() => {
    const d = window.__designer;
    d.select("furn", d.app.plan.furniture[0].id);
  });
  await page.waitForSelector("#selection-details", { visible: true });
  await send("添加一段隔墙");
  await page.waitForSelector("#pending-proposal", { visible: true });
  await chatDone();
  await page.$eval("#chat-input", (input) => {
    input.value =
      "保留家具布局。\n继续调整采光。\n考虑过道空间。\n保留电视柜的位置。\n检查整体布局。";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const crowdedLayouts = [];
  for (const [width, height] of [
    [1120, 760],
    [800, 600],
  ]) {
    await page.setViewport({ width, height });
    await page.$eval("#pending-proposal .secondary", (button) =>
      button.scrollIntoView({ block: "nearest" }),
    );
    const layout = await page.evaluate(() => {
      const box = (selector) =>
        document.querySelector(selector).getBoundingClientRect().toJSON();
      const send = document.querySelector("#send-chat");
      const rect = send.getBoundingClientRect();
      const hit = document.elementFromPoint(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
      );
      return {
        width: innerWidth,
        height: innerHeight,
        panel: box("#chat-panel"),
        heading: box(".chat-heading"),
        content: box("#chat-content"),
        form: box("#chat-form"),
        confirm: box("#pending-proposal .primary"),
        reject: box("#pending-proposal .secondary"),
        sendHit: send.contains(hit),
      };
    });
    assert.ok(layout.content.height > 0, JSON.stringify(layout));
    assert.ok(layout.heading.y >= layout.panel.y - 1, JSON.stringify(layout));
    assert.ok(layout.form.bottom <= height, JSON.stringify(layout));
    assert.ok(layout.confirm.y >= layout.content.y - 1, JSON.stringify(layout));
    assert.ok(
      layout.reject.bottom <= layout.content.bottom + 1,
      JSON.stringify(layout),
    );
    assert.equal(layout.sendHit, true, JSON.stringify(layout));
    crowdedLayouts.push(layout);
    await shot("crowded-chat-" + width);
  }
  measurements.crowdedChat = crowdedLayouts;
  await page.click("#pending-proposal .secondary");
  await page.$eval("#chat-input", (input) => {
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.setViewport({ width: 1600, height: 980 });
  pass(
    "Selected furniture, a pending proposal and multiline input keep the composer fixed and confirmation controls reachable",
  );

  // Confirm actual renderer geometry, not merely the response text or JSON status.
  await home();
  frame = await open("隔墙改造验收");
  assert.equal(
    await frame.evaluate(() => window.__designer.app.rooms.regions.length),
    2,
  );
  await frame.evaluate(
    (id) => window.__designer.select("wall", id),
    partition.id,
  );
  await send("拆除选中的非承重隔墙");
  await page.waitForFunction(
    () => !document.querySelector("#pending-proposal").hidden,
  );
  assert.ok(
    await frame.evaluate(
      (id) => window.__designer.app.geo.active.some((w) => w.w.id === id),
      partition.id,
    ),
  );
  await shot("wall-confirmation");
  await page.click("#pending-proposal .primary");
  await page.waitForFunction(
    () => document.querySelector("#pending-proposal").hidden,
  );
  assert.equal(
    await frame.evaluate(
      (id) => window.__designer.app.geo.active.some((w) => w.w.id === id),
      partition.id,
    ),
    false,
  );
  assert.equal(
    await frame.evaluate(() => window.__designer.app.rooms.regions.length),
    1,
  );
  assert.equal(
    app.store
      .variant(wallProject.id, wallProject.variants[0].id)
      .v.plan.walls.find((w) => w.id === partition.id).status,
    "removed",
  );
  await page.click("#undo-ai");
  await page.waitForFunction(
    () => document.querySelector("#editor-loading").hidden,
  );
  assert.equal(
    await frame.evaluate(() => window.__designer.app.rooms.regions.length),
    2,
  );
  pass(
    "Confirmed AI wall demolition changes real room geometry; undo restores the partition",
  );

  await home();
  await page.click("#new-project");
  await page.focus("#drop-zone");
  const picker = page.waitForFileChooser();
  await page.keyboard.press("Enter");
  const chooser = await picker;
  const png = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 600;
    c.height = 450;
    const ctx = c.getContext("2d");
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 12;
    ctx.strokeRect(20, 20, 560, 410);
    return c.toDataURL("image/png").split(",")[1];
  });
  const inputFile = join(directory, "transparent-input.png");
  writeFileSync(inputFile, Buffer.from(png, "base64"));
  await chooser.accept([inputFile]);
  await page.waitForFunction(() => {
    const im = document.querySelector("#image-preview");
    return !im.hidden && im.complete && im.naturalWidth > 0;
  });
  const pixels = await page.evaluate(() => {
    const c = document.createElement("canvas"),
      im = document.querySelector("#image-preview");
    c.width = im.naturalWidth;
    c.height = im.naturalHeight;
    const ctx = c.getContext("2d");
    ctx.drawImage(im, 0, 0);
    return {
      background: [...ctx.getImageData(0, 0, 1, 1).data],
      line: [...ctx.getImageData(20, 20, 1, 1).data],
    };
  });
  assert.ok(pixels.background.slice(0, 3).every((n) => n > 245));
  assert.ok(pixels.line.slice(0, 3).every((n) => n < 10));
  measurements.png = pixels;
  await shot("import-transparent");
  pass(
    "Keyboard file upload preserves black plan lines against a white JPEG background",
  );
  await page.click("#generate-button");
  frame = await ready();
  assert.equal(await page.$$eval("#variant-select option", (e) => e.length), 3);
  await page.click("#show-underlay");
  await frame.waitForFunction(
    () => window.__designer.app.underlay?.visible === true,
  );
  await frame.evaluate(() => {
    const d = window.__designer;
    d.app.underlay.mmPerPx = 12;
    d.app.underlay.x = 100;
    d.emit("underlay");
  });
  await page.click("#save-status");
  await page.waitForFunction(
    () => document.querySelector("#save-status").textContent === "已保存",
  );
  await page.select(
    "#variant-select",
    await page.$eval("#variant-select option:nth-child(2)", (e) => e.value),
  );
  frame = await ready();
  assert.equal(
    await frame.evaluate(() => window.__designer.app.underlay.mmPerPx),
    12,
  );
  assert.equal(
    await frame.evaluate(() => window.__designer.app.underlay.x),
    100,
  );
  pass(
    "Image generation creates three editable variants and preserves calibration across switching",
  );

  await home();
  frame = await open("日光客厅");
  const layouts = [];
  for (const [width, height] of [
    [1600, 980],
    [1366, 768],
    [1120, 760],
    [800, 600],
  ]) {
    await page.setViewport({ width, height });
    await pause(350);
    const layout = await page.evaluate(() => {
      const rect = (id) => {
        const r = document.getElementById(id).getBoundingClientRect();
        return {
          x: r.x,
          y: r.y,
          w: r.width,
          h: r.height,
          bottom: r.bottom,
          right: r.right,
        };
      };
      return {
        width: innerWidth,
        height: innerHeight,
        overflow: document.documentElement.scrollWidth > innerWidth,
        send: rect("send-chat"),
        model: rect("settings-button"),
        chat: rect("chat-panel"),
      };
    });
    assert.equal(layout.overflow, false, JSON.stringify(layout));
    assert.ok(
      layout.send.bottom <= height + 1 && layout.model.right <= width + 1,
      JSON.stringify(layout),
    );
    layouts.push(layout);
    await shot("editor-" + width);
  }
  measurements.layouts = layouts;
  pass(
    "Desktop, laptop, minimum window and enlarged-UI layouts keep send/settings controls visible without horizontal overflow",
  );
  await page.setViewport({ width: 1366, height: 768 });
  await page.click("#close-chat");
  assert.equal(
    await page.$eval("#toggle-chat", (e) => e.getAttribute("aria-expanded")),
    "false",
  );
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    "toggle-chat",
  );
  await page.keyboard.press("Enter");
  assert.equal(await page.$eval("#chat-panel", (e) => e.hidden), false);
  pass(
    "Chat collapse restores keyboard focus and exposes the correct expanded state",
  );
  await page.click("#settings-button");
  await page.select("#model-provider", "codex");
  await shot("settings-codex");
  await page.select("#model-provider", "api");
  await shot("settings-api");
  await page.keyboard.press("Escape");
  assert.equal(await page.$eval("#settings-dialog", (e) => e.open), false);
  assert.deepEqual(errors, []);
  pass(
    "Dialogs are named and keyboard dismissible; no uncaught renderer errors across the flows",
  );
} catch (error) {
  if (browser) {
    const pages = await browser.pages();
    await pages
      .at(-1)
      ?.screenshot({ path: join(directory, "failure.png") })
      .catch(() => {});
  }
  throw error;
} finally {
  writeFileSync(
    join(directory, "results.json"),
    JSON.stringify({ checks, errors, measurements }, null, 2),
  );
  await browser?.close();
  await app.close();
  await mock.close();
}
console.log(JSON.stringify({ checks: checks.length, errors, directory }));
