window.addEventListener("DOMContentLoaded", async () => {
  if (parent === window) return;
  const D = window.__designer,
    meta = window.__HOUSEDIY__,
    post = (data) =>
      parent.postMessage(
        { source: "housediy-editor", ...meta, ...data },
        location.origin,
      );
  if (!D) {
    post({ type: "error", message: "设计器接口未就绪" });
    return;
  }
  try {
    // Upstream initializes its undo baseline from the supplied preset plan.
    // Replacing again here would create a spurious first undo step.
    const singleFloorControls = () => {
      // The shell reports disk persistence; the upstream badge only tracks its
      // browser cache and otherwise contradicts the desktop save status.
      const browserSave = document.getElementById("stSave");
      if (browserSave) browserSave.hidden = true;
      document
        .querySelector("[data-addf]")
        ?.closest(".sec")
        ?.setAttribute("hidden", "");
      const schemes = document.getElementById("schemeBtn");
      if (schemes) {
        schemes.disabled = true;
        schemes.title = "在顶部切换或另存方案";
      }
    };
    singleFloorControls();
    new MutationObserver(singleFloorControls).observe(document.body, {
      childList: true,
      subtree: true,
    });
    if (window.__PRESET__.underlay) {
      D.app.underlay = { ...window.__PRESET__.underlay };
      D.bld.uls[D.bld.cur] = D.app.underlay;
      D.emit("underlay");
    }
    let gesture = false;
    window.addEventListener("pointerdown", () => (gesture = true), true);
    window.addEventListener("pointerup", () => (gesture = false), true);
    window.addEventListener("pointercancel", () => (gesture = false), true);
    window.addEventListener("blur", () => (gesture = false));
    const settleView = async () => {
      const deadline = performance.now() + 15000;
      while (D.app.transitioning || D.S3.isAnimating()) {
        if (performance.now() > deadline)
          throw new Error("视图加载超时，请重新打开方案");
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    };
    const state = () => ({
      plan: structuredClone(D.app.plan),
      underlay: D.app.underlay
        ? Object.fromEntries(
            [
              "src",
              "imgW",
              "imgH",
              "mmPerPx",
              "x",
              "y",
              "opacity",
              "visible",
              "locked",
            ].map((key) => [key, D.app.underlay[key]]),
          )
        : null,
      selection: structuredClone(D.app.sel),
      gesture,
    });
    const checks = () =>
      D.runChecks()
        .issues.map(({ level, type, msg, targets }) => ({
          level,
          type,
          msg,
          targets,
        }))
        .slice(0, 60);
    window.addEventListener("message", async (event) => {
      if (
        event.source !== parent ||
        event.origin !== location.origin ||
        event.data?.source !== "housediy-shell"
      )
        return;
      const { requestId, action, payload } = event.data;
      try {
        let result;
        if (action === "state") result = state();
        else if (action === "apply") {
          if (gesture) throw new Error("请先结束当前拖动，再应用 AI 修改");
          if (
            payload.expected &&
            JSON.stringify(D.app.plan) !== payload.expected
          )
            throw new Error("画面中的方案已被手动修改，请重新提出需求");
          D.replacePlan(structuredClone(payload.plan));
          D.requestDraw();
          if (D.S3.ready) D.S3.renderNow();
          result = { ...state(), issues: checks() };
        } else if (action === "undo") {
          if (gesture) throw new Error("请先结束当前拖动");
          const changed = D.undo();
          D.requestDraw();
          if (D.S3.ready) D.S3.renderNow();
          result = { changed, ...state() };
        } else if (action === "checks") result = { issues: checks() };
        else if (action === "view") {
          await settleView();
          await D.setView(payload);
          await settleView();
          result = { ok: true };
        } else if (action === "select") {
          D.select(payload.kind, payload.id);
          result = state();
        } else if (action === "underlay") {
          if (D.app.underlay) {
            D.app.underlay.visible = !D.app.underlay.visible;
            D.emit("underlay");
            D.requestDraw();
          }
          result = { visible: D.app.underlay?.visible ?? false };
        } else throw new Error("不支持的编辑请求");
        post({ type: "reply", requestId, result });
      } catch (error) {
        post({ type: "reply", requestId, error: error.message });
      }
    });
    let lastPlan = JSON.stringify({
        plan: D.app.plan,
        underlay: state().underlay,
      }),
      lastSelection = JSON.stringify(D.app.sel);
    setInterval(() => {
      if (gesture) return;
      const plan = JSON.stringify({
          plan: D.app.plan,
          underlay: state().underlay,
        }),
        sel = JSON.stringify(D.app.sel);
      if (plan !== lastPlan) {
        lastPlan = plan;
        post({ type: "changed" });
      }
      if (sel !== lastSelection) {
        lastSelection = sel;
        const selection = D.app.sel,
          lists = {
            furn: "furniture",
            room: "rooms",
            wall: "walls",
            opening: "openings",
          };
        const item = D.app.plan[lists[selection.kind]]?.find(
          (v) => v.id === selection.id,
        );
        post({
          type: "selection",
          selection,
          label:
            item?.name ||
            (selection.kind === "wall"
              ? "墙体"
              : selection.kind === "opening"
                ? "门窗"
                : ""),
        });
      }
    }, 350);
    D.fit2D();
    await D.setView("3d");
    // setView schedules its camera transition after returning. Apply our bird's-eye
    // pose only after it settles, otherwise that transition overwrites the pose.
    await settleView();
    const pose = D.S3.birdPose();
    const aspect = D.S3.sceneRefs().camera.aspect;
    // Leave room around the whole model when the property panels narrow the canvas.
    pose.r *= 1.08 / Math.min(1, aspect);
    D.S3.setPose({ ...pose, p: 0.45, t: -0.25 });
    D.S3.renderNow();
    post({ type: "ready", ...state() });
    post({ type: "three-ready", issues: checks() });
  } catch (error) {
    post({ type: "error", message: error.message });
  }
});
