window.addEventListener("DOMContentLoaded", async () => {
  if (parent === window) return;
  const { requireDesignReview, designFindings, mergeDesignFindings } =
    await import("/design-rules.js");
  const D = window.__designer,
    meta = window.__HOUSEDIY__,
    structureLabel = window.__wallStructureLabel,
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
    const { openingRecovery } = await import("/editor-recovery.js");
    const { snapshotUnderlay, sameUnderlay } =
      await import("/editor-session.js");
    const recovery = openingRecovery(D, post);
    await window.__houseModelsReady;
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
      underlay: snapshotUnderlay(D.app.underlay),
      selection: structuredClone(D.app.sel),
      gesture,
    });
    const checks = (preferences = window.__PRESET__.designPreferences) => {
      const { plan } = D.app;
      const kinds = new Map();
      for (const [key, kind] of [
        ["furniture", "furn"],
        ["rooms", "room"],
        ["walls", "wall"],
        ["openings", "opening"],
        ["elec", "elec"],
        ["structs", "struct"],
      ])
        for (const item of plan[key]) kinds.set(item.id, kind);
      const report = (run, name) => {
        try {
          return run();
        } catch {
          return [
            {
              level: "warn",
              type: "检查",
              msg: name + "未完成，可稍后重新检查。",
              targets: [],
            },
          ];
        }
      };
      return mergeDesignFindings(
        report(() => designFindings(plan, preferences), "布局检查"),
        report(() => D.runChecks().issues, "编辑器检查"),
      ).map(({ level, type, msg, targets, rule }) => ({
        level,
        type,
        msg,
        rule,
        targets: (targets ?? [])
          .map((t) => ({ id: t.id, kind: kinds.get(t.id) }))
          .filter((t) => t.kind),
      }));
    };
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
          requireDesignReview(D.app.plan, payload.plan, payload.preferences);
          D.replacePlan(structuredClone(payload.plan));
          D.requestDraw();
          if (D.S3.ready) D.S3.renderNow();
          result = { ...state(), issues: checks(payload.preferences) };
        } else if (action === "undo") {
          if (gesture) throw new Error("请先结束当前拖动");
          const changed = D.undo();
          D.requestDraw();
          if (D.S3.ready) D.S3.renderNow();
          result = { changed, ...state() };
        } else if (action === "checks")
          result = { issues: checks(payload?.preferences) };
        else if (action === "view") {
          if (payload === "2d") await D.setView("2d", true);
          else {
            await settleView();
            await D.setView(payload);
            await settleView();
          }
          result = { ok: true };
        } else if (action === "sourceTool" || action === "prepareOpening") {
          await D.setView("2d", true);
          if (D.app.underlay && !D.app.underlay.visible) {
            D.app.underlay.visible = true;
            D.emit("underlay");
          }
          const tool = action === "prepareOpening" ? "select" : payload;
          if (!["select", "wall", "calibrate"].includes(tool))
            throw new Error("底图工具无效");
          D.setTool(tool);
          D.requestDraw();
          recovery.update();
          if (action === "sourceTool") document.getElementById("c2d").focus();
          result =
            action === "prepareOpening"
              ? recovery.choices(payload.id)
              : { ok: true };
        } else if (action === "attachOpening") {
          if (gesture) throw new Error("请先结束当前拖动");
          recovery.attach(payload);
          result = state();
        } else if (action === "select") {
          D.select(payload.kind, payload.id);
          result = state();
        } else if (action === "color") {
          if (gesture) throw new Error("请先结束当前拖动");
          const selection = D.app.sel;
          if (selection.kind !== "furn" || selection.id !== payload.id)
            throw new Error("选中的家具已变化，请重新选择颜色");
          if (!/^#[a-f0-9]{6}$/i.test(payload.color))
            throw new Error("颜色格式不正确");
          const item = D.app.plan.furniture.find((f) => f.id === payload.id);
          if (!item) throw new Error("选中的家具不存在");
          const color = payload.color.toLowerCase();
          const changed = item.color?.toLowerCase() !== color;
          if (changed) {
            item.color = color;
            D.commit();
            D.requestDraw();
            if (D.S3.ready) D.S3.renderNow();
          }
          result = { changed };
        } else if (action === "restoreModel") {
          const { id, file } = payload;
          if (!window.houseModels.missing.has(id) || !(file instanceof File))
            throw new Error("请选择此模型的原始 GLB 文件");
          if (file.size > 64_000_000)
            throw new Error("单个 GLB 模型上限为 64 MB");
          await D.importModel(file, id);
          result = { ok: true };
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
    // The editor already serializes a plan when it commits. Remember that an
    // edit happened, then compare once after the pointer is released.
    let planDirty = false;
    const markPlan = () => {
      planDirty = true;
    };
    for (const eventName of ["commit", "change", "underlay", "phase"])
      D.on(eventName, markPlan);
    let lastPlan = JSON.stringify(D.app.plan),
      lastUnderlay = snapshotUnderlay(D.app.underlay),
      lastSelection = "";
    setInterval(() => {
      recovery.update();
      if (gesture) return;
      const underlayChanged = !sameUnderlay(lastUnderlay, D.app.underlay);
      if (planDirty || underlayChanged) {
        planDirty = false;
        const plan = JSON.stringify(D.app.plan);
        if (plan !== lastPlan || underlayChanged) {
          lastPlan = plan;
          lastUnderlay = snapshotUnderlay(D.app.underlay);
          post({ type: "changed" });
        }
      }
      const selectedFurniture = D.app.plan.furniture.find(
          (f) => D.app.sel.kind === "furn" && f.id === D.app.sel.id,
        ),
        sel = JSON.stringify([
          D.app.sel,
          selectedFurniture?.name,
          selectedFurniture?.color,
        ]);
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
          color: selectedFurniture?.color || "",
          label:
            item?.name ||
            (selection.kind === "wall"
              ? item
                ? structureLabel(item)
                : "墙体"
              : selection.kind === "opening"
                ? "门窗"
                : ""),
        });
      }
    }, 350);
    D.fit2D();
    let viewWarning;
    if (
      D.app.plan.walls.length ||
      !D.app.underlay ||
      D.app.plan.furniture.length
    ) {
      try {
        await D.setView("3d");
        await settleView();
        D.fitOverview();
      } catch {
        await D.setView("2d", true);
        D.fit2D();
        D.requestDraw();
        viewWarning = "3D 视图未能打开，已保留二维编辑。可再次点击「3D」重试。";
      }
    } else {
      await D.setView("2d");
      D.fit2D();
    }
    const missingModels = [...window.houseModels.missing].map((id) => ({
      id,
      name:
        D.app.plan.furniture.find(
          (f) => f.modelId === id || f.key === "model:" + id,
        )?.name || id,
    }));
    post({
      type: "ready",
      ...state(),
      missingModels,
      viewWarning,
      modelWarnings: window.houseModels.warnings,
    });
    recovery.update();
    post({ type: "three-ready", issues: checks() });
  } catch (error) {
    post({ type: "error", message: error.message });
  }
});
