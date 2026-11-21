// Presentation adapter for the pinned upstream editor. Reuse its controls and
// history rather than introducing a second editor or writing into its bundle.
window.addEventListener("DOMContentLoaded", () => {
  const D = window.__designer;
  if (!D) return;
  const $ = (id) => document.getElementById(id);
  const make = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const icon = (name) => {
    const el = make("span", "ui-icon");
    el.style.setProperty("--icon", `url('/icons/${name}.svg')`);
    el.setAttribute("aria-hidden", "true");
    return el;
  };
  const button = (label, glyph, action, className = "atelier-button") => {
    const el = make("button", className);
    el.type = "button";
    el.title = label;
    el.setAttribute("aria-label", label);
    el.append(icon(glyph), make("span", "", label));
    el.onclick = action;
    return el;
  };
  const body = document.body;
  const stage = $("stage");
  const header = document.querySelector(".app > header");
  const left = $("leftPanel");
  const inspector = $("inspector");
  body.classList.add("atelier-editor", "hide-left", "hide-right");

  const rail = make("nav", "atelier-rail");
  rail.setAttribute("aria-label", "设计工具");
  const nav = new Map();
  const resize = () => window.dispatchEvent(new Event("resize"));
  let splitPanelOpen = false;
  const syncPanels = () => {
    const leftOpen = !body.classList.contains("hide-left");
    const rightOpen = !body.classList.contains("hide-right");
    const tab = left.querySelector(".tabs .on")?.dataset.tab;
    for (const [key, el] of nav) {
      const active = key === "materials" ? rightOpen : leftOpen && tab === key;
      el.classList.toggle("on", active);
      el.setAttribute("aria-expanded", String(active));
    }
    properties.setAttribute("aria-expanded", String(rightOpen));
    const needsRoom = stage.dataset.view === "split" && (leftOpen || rightOpen);
    if (splitPanelOpen !== needsRoom) {
      splitPanelOpen = needsRoom;
      parent.postMessage(
        {
          source: "housediy-editor",
          ...window.__HOUSEDIY__,
          type: "split-panel",
          open: needsRoom,
        },
        location.origin,
      );
    }
  };
  const panel = (side, open) => {
    body.classList.toggle(`hide-${side}`, !open);
    body.classList.toggle(`${side}-open`, open);
    syncPanels();
    resize();
  };
  const showLibrary = (tab) => {
    const same = left.querySelector(".tabs .on")?.dataset.tab === tab;
    const open = body.classList.contains("hide-left") || !same;
    if (open) {
      left.querySelector(`[data-tab="${tab}"]`)?.click();
      panel("right", false);
    }
    panel("left", open);
  };
  const showProperties = () => {
    inspector.querySelector('[data-t="props"]')?.click();
    panel("left", false);
    panel("right", body.classList.contains("hide-right"));
  };
  for (const [key, label, glyph] of [
    ["plan", "空间", "house"],
    ["furn", "家具", "couch"],
    ["materials", "材质", "stack"],
  ]) {
    const el = button(
      label,
      glyph,
      key === "materials" ? showProperties : () => showLibrary(key),
      "atelier-nav",
    );
    el.dataset.panel = key;
    el.setAttribute(
      "aria-controls",
      key === "materials" ? "inspector" : "leftPanel",
    );
    nav.set(key, el);
    rail.append(el);
  }
  const measure = button(
    "测量",
    "ruler",
    () => D.setTool("measure"),
    "atelier-nav",
  );
  measure.dataset.workspaceTool = "measure";
  rail.append(measure);
  const railBottom = make("div", "atelier-rail-bottom");
  const more = button(
    "更多",
    "dots-three",
    () => {
      const open = body.classList.toggle("atelier-more");
      more.setAttribute("aria-expanded", String(open));
    },
    "atelier-nav",
  );
  more.setAttribute("aria-expanded", "false");
  more.setAttribute("aria-controls", "atelier-advanced");
  railBottom.append(more);
  rail.append(railBottom);
  document.querySelector(".app > main").prepend(rail);

  const title = make("div", "atelier-title");
  title.append($("planTitle"));
  const subtitle = make("p", "atelier-subtitle");
  title.append(subtitle);
  stage.append(title);
  const views = make("div", "atelier-views");
  views.append($("viewSeg"));
  stage.append(views);
  const drawingTools = make("div", "atelier-drawing-tools");
  drawingTools.append($("layerSeg"), $("toolHint"));
  stage.append(drawingTools);
  D.fitOverview = (margin = 1.08) => {
    const pose = D.S3.birdPose();
    const aspect =
      $("pane3d").clientWidth / Math.max(1, $("pane3d").clientHeight);
    pose.r *= margin / Math.min(1, Math.max(0.1, aspect));
    D.S3.setPose({ ...pose, p: 0.45, t: -0.25 });
    D.S3.renderNow();
  };
  let cameraTimer;
  const fitSplit = () => {
    clearTimeout(cameraTimer);
    if (stage.dataset.view !== "split" || !D.S3.ready || D.S3.fp.active) return;
    if (D.app.transitioning || D.S3.isAnimating()) {
      cameraTimer = setTimeout(fitSplit, 120);
      return;
    }
    D.fitOverview(1.18);
  };
  const syncView = () => {
    const view = stage.dataset.view;
    for (const control of views.querySelectorAll("[data-view]"))
      control.setAttribute(
        "aria-pressed",
        String(control.dataset.view === view),
      );
    $("pane3d").inert = view === "2d";
    $("pane2d").inert = view === "3d";
    drawingTools.hidden = view === "3d";
  };
  new MutationObserver(() => {
    syncView();
    syncPanels();
    fitSplit();
  }).observe(stage, { attributes: true, attributeFilter: ["data-view"] });
  syncView();
  let fitTimer;
  new ResizeObserver(() => {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      const pane = $("pane2d");
      if (
        stage.dataset.view !== "3d" &&
        pane.clientWidth > 205 &&
        pane.clientHeight > 205
      )
        D.fit2D(pane.clientWidth - 18, pane.clientHeight - 18);
      fitSplit();
    }, 120);
  }).observe($("pane2d"));

  header.id = "atelier-advanced";
  header.classList.add("atelier-advanced");
  header.setAttribute("aria-label", "完整设计工具");
  stage.append(header);
  const closeAdvanced = button("收起工具", "x", () => {
    body.classList.remove("atelier-more");
    more.setAttribute("aria-expanded", "false");
    more.focus();
  });
  header.append(closeAdvanced);

  const toolbar = make("div", "atelier-toolbar");
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "常用编辑操作");
  const select = button("选择", "cursor", () => D.setTool("select"));
  select.dataset.workspaceTool = "select";
  toolbar.append(select);
  const objectButtons = [];
  for (const [action, label, glyph] of [
    ["rot", "旋转", "arrow-clockwise"],
    ["dup", "复制", "stack"],
  ]) {
    const el = button(label, glyph, () => {
      inspector.querySelector('[data-t="props"]')?.click();
      inspector.querySelector(`[data-a="${action}"]`)?.click();
    });
    el.dataset.objectAction = action;
    objectButtons.push(el);
    toolbar.append(el);
  }
  const properties = button("属性", "sliders-horizontal", showProperties);
  properties.setAttribute("aria-controls", "inspector");
  toolbar.append(properties);
  for (const [id, label, glyph] of [
    ["undoBtn", "撤销", "arrow-counter-clockwise"],
    ["redoBtn", "重做", "arrow-clockwise"],
  ]) {
    const el = $(id);
    el.replaceChildren(icon(glyph), make("span", "", label));
    el.className = "atelier-button";
    el.setAttribute("aria-label", label);
    toolbar.append(el);
  }
  stage.append(toolbar);

  const viewportTools = make("div", "atelier-viewport-tools");
  const reset = $("camReset");
  const fit = button("适应窗口", "arrows-out", () => {
    if (D.app.view === "2d") D.fit2D();
    else reset.click();
  });
  viewportTools.append(fit);
  stage.append(viewportTools);

  // Keep all original camera, lighting, export, and specialist tools reachable.
  const cameraTools = document.querySelector("#pane3d > .overlay.ov-tl");
  cameraTools.classList.add("atelier-camera-tools");
  const cameraToggle = button(
    "视角与光照",
    "sun",
    () => {
      const open = body.classList.toggle("atelier-camera-open");
      cameraToggle.setAttribute("aria-expanded", String(open));
    },
    "atelier-camera-toggle",
  );
  cameraToggle.setAttribute("aria-expanded", "false");
  stage.append(cameraToggle);
  for (const [id, label, glyph] of [
    ["lightBtn", "光照", "sun"],
    ["lookBtn", "显示风格", "palette"],
    ["mepBtn", "管线", "lightning"],
    ["smartBtn", "智能中控", "house"],
  ]) {
    const el = $(id);
    el.replaceChildren(icon(glyph), make("span", "", label));
    el.classList.add("atelier-camera-button");
  }

  const update = () => {
    const area = $("stArea").textContent.match(
      /([\d.]+)\s*m²|([\d.]+)\s*㎡|([\d.]+)\s*m2/,
    );
    const areaText = area
      ? `${area[1] || area[2] || area[3]} m²`
      : "可编辑的家居方案";
    const room =
      D.app.plan.rooms?.length === 1 ? D.app.plan.rooms[0].name : "你的空间";
    const text = `${areaText} · ${room || "你的空间"}`;
    if (subtitle.textContent !== text) subtitle.textContent = text;
    const furniture = D.app.sel.kind === "furn";
    for (const el of objectButtons) el.disabled = !furniture;
    for (const el of [select, measure]) {
      const active = el.dataset.workspaceTool === D.app.tool;
      el.classList.toggle("on", active);
      el.setAttribute("aria-pressed", String(active));
    }
    cameraToggle.hidden = D.app.view === "2d";
    syncPanels();
  };
  new MutationObserver(update).observe(inspector, {
    childList: true,
    subtree: true,
  });
  new MutationObserver(syncPanels).observe(body, {
    attributes: true,
    attributeFilter: ["class"],
  });
  new MutationObserver(update).observe($("stArea"), {
    childList: true,
    subtree: true,
  });
  setInterval(update, 350);
  window.addEventListener("keydown", (event) => {
    if (
      event.key !== "Escape" ||
      event.target.matches("input,textarea,select,[contenteditable]")
    )
      return;
    if (
      document.querySelector(".modal") ||
      body.classList.contains("smart-mode")
    )
      return;
    const wasOpen =
      body.classList.contains("atelier-more") ||
      body.classList.contains("atelier-camera-open");
    body.classList.remove("atelier-more", "atelier-camera-open");
    more.setAttribute("aria-expanded", "false");
    cameraToggle.setAttribute("aria-expanded", "false");
    panel("left", false);
    panel("right", false);
    if (wasOpen) more.focus();
  });
  update();
  resize();
});
