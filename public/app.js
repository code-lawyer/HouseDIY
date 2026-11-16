import { EditorSession } from "/editor-session.js";
const $ = (id) => document.getElementById(id);
const make = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
};
let current = null,
  settings = null,
  workspacePromise = null,
  workspaceLocked = false,
  controller = null,
  selectedImage = null,
  selectedFurniture = null,
  pending = null,
  requestSequence = 0,
  loginController = null,
  loginUrl = "";
const requests = new Map();
async function api(path, body) {
  const r = await fetch(
    path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await r.json();
  if (!r.ok) {
    const e = new Error(data.error || "请求失败");
    e.status = r.status;
    throw e;
  }
  return data;
}
function toast(text) {
  $("toast").textContent = text;
  $("toast").hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("toast").hidden = true), 5500);
}
function fitComposer() {
  const input = $("chat-input");
  input.style.height = "auto";
  input.style.height = Math.min(140, input.scrollHeight) + "px";
}
$("chat-input").addEventListener("input", fitComposer);
function rpc(action, payload, session = current) {
  if (!session || session !== current || !session.active || !session.ready)
    return Promise.reject(new Error("设计器正在加载，请稍候"));
  const requestId = ++requestSequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      requests.delete(requestId);
      reject(new Error("设计器没有及时响应，请保存后重新打开项目"));
    }, 20000);
    requests.set(requestId, { resolve, reject, timer });
    $("designer").contentWindow.postMessage(
      { source: "housediy-shell", requestId, action, payload },
      location.origin,
    );
  });
}
function saveLabel(text, dirty = false) {
  $("save-status").textContent = text;
  $("save-status").classList.toggle("dirty", dirty);
}
const saveNow = (description, session = current) => session?.save(description);
function scheduleSave() {
  current?.schedule((e) => toast(e.message));
}
function lockWorkspace(locked, label) {
  workspaceLocked = locked;
  const unavailable = locked || (!!current && !current.ready);
  $("designer").inert = unavailable;
  for (const id of [
    "project-toolbar",
    "chat-form",
    "chat-tools",
    "pending-proposal",
    "selection-details",
  ])
    $(id).inert = unavailable;
  $("home-button").disabled = locked;
  $("toggle-chat").disabled = locked;
  $("editor-view").setAttribute("aria-busy", String(unavailable));
  if (locked && current) {
    $("editor-loading").replaceChildren(
      make("span", "spinner"),
      make("p", "", label),
    );
    $("editor-loading").hidden = false;
  } else if (current?.ready) $("editor-loading").hidden = true;
}
async function inWorkspace(task, label = "正在保存当前方案…") {
  if (workspacePromise) throw new Error("正在处理当前方案，请稍候");
  const session = current;
  lockWorkspace(true, label);
  workspacePromise = Promise.resolve().then(() => task(session));
  try {
    return await workspacePromise;
  } finally {
    workspacePromise = null;
    lockWorkspace(false);
  }
}
function requireSession(session) {
  if (!session || current !== session || !session.active || !session.ready)
    throw new Error("已切换方案，请在当前方案重新操作");
}
window.addEventListener("message", async (event) => {
  if (
    event.origin !== location.origin ||
    event.source !== $("designer").contentWindow ||
    event.data?.source !== "housediy-editor" ||
    !current
  )
    return;
  const data = event.data;
  if (
    data.projectId !== current.project.id ||
    data.variantId !== current.variant.id
  )
    return;
  if (data.type === "reply") {
    const r = requests.get(data.requestId);
    if (r) {
      clearTimeout(r.timer);
      requests.delete(data.requestId);
      data.error ? r.reject(new Error(data.error)) : r.resolve(data.result);
    }
    return;
  }
  if (data.type === "ready") {
    current.ready = true;
    lockWorkspace(workspaceLocked, "正在保存当前方案…");
    saveNow("打开并整理模型").catch((e) => toast(e.message));
  }
  if (data.type === "three-ready") showLayoutFeedback(data.issues);
  if (data.type === "changed") scheduleSave();
  if (data.type === "selection") {
    const previousSelection = selectedFurniture;
    $("selection-chip").hidden = !data.label;
    $("selection-chip").textContent = data.label
      ? "已选中 · " + data.label
      : "";
    selectedFurniture =
      data.selection.kind === "furn" ? data.selection.id : null;
    $("selection-details").hidden = !selectedFurniture;
    $("selection-name").textContent = "已选中 · " + (data.label || "家具");
    for (const button of document.querySelectorAll("[data-color]"))
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.color === data.color?.toLowerCase()),
      );
    if (selectedFurniture && selectedFurniture !== previousSelection)
      $("selection-details").scrollIntoView({ block: "nearest" });
  }
  if (data.type === "error") {
    current.ready = false;
    lockWorkspace(false);
    const retry = make("button", "secondary", "重新打开方案");
    retry.onclick = () =>
      loadProject(current.project.id, current.variant.id).catch((e) =>
        toast(e.message),
      );
    $("editor-loading").replaceChildren(make("p", "", data.message), retry);
    $("editor-loading").hidden = false;
    toast(data.message);
  }
});
function clearPending() {
  pending = null;
  $("pending-proposal").hidden = true;
  $("pending-proposal").replaceChildren();
}
for (const button of document.querySelectorAll("[data-color]")) {
  button.onclick = async () => {
    const session = current;
    const id = selectedFurniture;
    if (!id || workspaceLocked) return;
    try {
      requireSession(session);
      const { changed } = await rpc(
        "color",
        { id, color: button.dataset.color },
        session,
      );
      requireSession(session);
      if (!changed) {
        toast("已经是" + button.dataset.colorName + "色，未作修改。");
        return;
      }
      await saveNow("配色：" + button.dataset.colorName, session);
      await recordAction(
        session,
        "已调整家具颜色为" + button.dataset.colorName + "色。可以用撤销回退。",
      );
    } catch (error) {
      toast(error.message);
    }
  };
}
function showLayoutFeedback(issues = []) {
  const count = issues.filter((i) => i.level === "error").length;
  $("layout-feedback").hidden = !count;
  $("layout-feedback-text").textContent =
    `检测到 ${count} 处家具重叠或墙体冲突`;
}
$("fix-layout").onclick = () => {
  $("chat-input").value =
    "请根据当前检查结果，优先解决家具重叠和嵌入墙体的问题。只调整相关家具，保留墙体、门窗和其他布置。";
  fitComposer();
  $("chat-input").focus();
};
function appendMessage(role, content, kind) {
  const msg = make("div", "message " + (kind || role));
  if (!kind)
    msg.append(
      make(
        "span",
        "message-label",
        role === "user" ? "你" : "HouseDIY · 设计助手",
      ),
    );
  msg.append(make("span", "message-content", content));
  $("messages").append(msg);
  msg.scrollIntoView({ block: "end" });
  return msg;
}
function renderMessages() {
  const list = $("messages");
  list.replaceChildren();
  const messages = current.variant.messages ?? [];
  if (!messages.length) {
    const welcome = make("div", "chat-welcome");
    welcome.append(
      make("h3", "", "家的样子，\n从你的想法开始。"),
      make(
        "p",
        "",
        "选一件家具，或者聊聊你期待的生活。我们一起，把想法慢慢落到实处。",
      ),
    );
    for (const text of [
      "查看当前布局，有哪些可以改善的地方？",
      "把沙发换成暖米色",
      "帮我找一张适合两个人的书桌",
    ]) {
      const b = make("button", "suggestion", text);
      b.type = "button";
      b.onclick = () => {
        $("chat-input").value = text;
        fitComposer();
        $("chat-input").focus();
      };
      welcome.append(b);
    }
    list.append(welcome);
  } else for (const m of messages) appendMessage(m.role, m.content, m.kind);
}
async function loadProject(projectId, variantId) {
  return inWorkspace(async (session) => {
    controller?.abort();
    await saveNow(undefined, session);
    await openProject(projectId, variantId);
  });
}
async function openProject(projectId, variantId) {
  clearPending();
  const project = await api("/api/projects/" + projectId),
    variant =
      project.variants.find((v) => v.id === variantId) ?? project.variants[0];
  current?.dispose();
  for (const r of requests.values()) {
    clearTimeout(r.timer);
    r.reject(new Error("已切换方案"));
  }
  requests.clear();
  const session = new EditorSession(project, variant, {
    readState: () => rpc("state", undefined, session),
    write: api,
    status: (text, dirty) => {
      if (current === session) saveLabel(text, dirty);
    },
  });
  current = session;
  $("home-view").hidden = true;
  document.body.classList.add("editing");
  $("editor-view").hidden = false;
  $("project-toolbar").hidden = false;
  $("toggle-chat").hidden = false;
  setChatVisible(true);
  $("project-name").textContent = project.name;
  $("variant-select").replaceChildren();
  for (const v of project.variants) {
    const op = make("option", "", v.name);
    op.value = v.id;
    $("variant-select").append(op);
  }
  $("variant-select").value = variant.id;
  $("assumption-list").replaceChildren(
    ...project.assumptions.map((text) => make("li", "", text)),
  );
  $("assumptions").hidden = !project.assumptions.length;
  $("show-underlay").hidden = !project.underlay;
  $("selection-chip").hidden = true;
  selectedFurniture = null;
  $("selection-details").hidden = true;
  $("layout-feedback").hidden = true;
  $("chat-input").value = "";
  fitComposer();
  renderMessages();
  saveLabel("正在打开…");
  $("editor-loading").replaceChildren(
    make("span", "spinner"),
    make("p", "", "正在打开你的设计…"),
  );
  $("editor-loading").hidden = false;
  $("designer").src = `/editor/${project.id}/${variant.id}?load=${Date.now()}`;
}
async function goHome() {
  return inWorkspace(async (session) => {
    controller?.abort();
    await saveNow(undefined, session);
    clearPending();
    session?.dispose();
    current = null;
    $("designer").src = "about:blank";
    $("editor-view").hidden = true;
    $("project-toolbar").hidden = true;
    $("toggle-chat").hidden = true;
    $("home-view").hidden = false;
    document.body.classList.remove("editing");
    selectedFurniture = null;
    $("selection-details").hidden = true;
    await renderProjects();
  });
}
function drawPreview(canvas, plan) {
  const ctx = canvas.getContext("2d");
  canvas.width = 660;
  canvas.height = 332;
  ctx.fillStyle = "#eeeadf";
  ctx.fillRect(0, 0, 660, 332);
  if (!plan.nodes.length) return;
  const xs = plan.nodes.map((n) => n.x),
    ys = plan.nodes.map((n) => n.y),
    minX = Math.min(...xs),
    minY = Math.min(...ys),
    width = Math.max(...xs) - minX,
    height = Math.max(...ys) - minY,
    scale = Math.min(530 / Math.max(1, width), 240 / Math.max(1, height)),
    ox = (660 - width * scale) / 2 - minX * scale,
    oy = (332 - height * scale) / 2 - minY * scale;
  const nodes = new Map(plan.nodes.map((n) => [n.id, n]));
  ctx.lineCap = "butt";
  for (const f of plan.furniture) {
    ctx.save();
    ctx.translate(ox + f.x * scale, oy + f.y * scale);
    ctx.rotate((f.rot * Math.PI) / 180);
    ctx.fillStyle = f.color || "#c1ccda";
    ctx.globalAlpha = 0.8;
    ctx.fillRect(
      (-f.w * scale) / 2,
      (-f.d * scale) / 2,
      f.w * scale,
      f.d * scale,
    );
    ctx.restore();
  }
  for (const wall of plan.walls) {
    if (["removed", "demolish"].includes(wall.status)) continue;
    const a = nodes.get(wall.a),
      b = nodes.get(wall.b);
    if (!a || !b) continue;
    ctx.strokeStyle = wall.bearing ? "#68715e" : "#a4aa96";
    ctx.lineWidth = Math.max(2, wall.t * scale);
    ctx.beginPath();
    ctx.moveTo(ox + a.x * scale, oy + a.y * scale);
    ctx.lineTo(ox + b.x * scale, oy + b.y * scale);
    ctx.stroke();
  }
}
async function renderProjects() {
  const projects = await api("/api/projects");
  $("project-count").textContent = projects.length + " 个本地项目";
  $("project-list").replaceChildren();
  for (const p of projects) {
    const card = make("button", "project-card"),
      preview = make("div", "project-preview"),
      canvas = make("canvas"),
      body = make("div", "project-card-body");
    preview.append(canvas);
    const line = make("p");
    line.append(
      make("span", "", p.variantCount + " 套设计方案"),
      make("span", "", new Date(p.updatedAt).toLocaleDateString("zh-CN")),
    );
    body.append(make("h3", "", p.name), line);
    card.append(preview, make("span", "arrow", "↗"), body);
    card.onclick = () => loadProject(p.id).catch((e) => toast(e.message));
    $("project-list").append(card);
    api("/api/projects/" + p.id)
      .then((full) => drawPreview(canvas, full.variants[0].plan))
      .catch(() => {});
  }
}
async function readStream(path, body, signal, onEvent) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "请求失败");
  }
  let buffer = "",
    result;
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const record = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = record
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
      if (!data) continue;
      const event = JSON.parse(data);
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "result") result = event;
      onEvent?.(event);
    }
  }
  if (!result) throw new Error("连接已结束，但没有收到完整结果");
  return result;
}
function setChatBusy(busy) {
  $("send-chat").hidden = busy;
  $("stop-chat").hidden = !busy;
  $("chat-progress").hidden = !busy;
  $("chat-input").disabled = busy;
}
async function recordAction(session, text) {
  if (current === session) appendMessage("assistant", text, "action");
  session.variant.messages.push({
    role: "assistant",
    content: text,
    kind: "action",
  });
  try {
    await api(session.endpoint("note"), { content: text });
  } catch {}
}
async function applyProposal(session, proposal, expected, baseRevision) {
  requireSession(session);
  if (session.revision !== baseRevision)
    throw new Error("方案已更新，请重新提出这条需求");
  const state = await rpc("apply", { plan: proposal.plan, expected }, session);
  await saveNow("AI：" + proposal.summary.join("；"), session);
  showLayoutFeedback(state.issues);
  await recordAction(
    session,
    "已应用：" + proposal.summary.join("；") + "。可以用撤销回退。",
  );
  clearPending();
  const errors = state.issues.filter((i) => i.level === "error");
  if (errors.length)
    appendMessage(
      "assistant",
      "设计器检查提示：\n" +
        errors
          .slice(0, 5)
          .map((i) => "· " + i.msg)
          .join("\n") +
        "\n可继续告诉我需要怎样调整。",
    );
}
function showProposal(session, proposal, expected, baseRevision) {
  pending = { session, proposal, expected, baseRevision };
  const box = $("pending-proposal");
  box.replaceChildren(
    make("strong", "", "墙体与门窗调整"),
    make("p", "", proposal.warnings.join(" ")),
  );
  const ul = make("ul");
  for (const text of proposal.summary) ul.append(make("li", "", text));
  const apply = make("button", "primary", "应用到方案"),
    reject = make("button", "secondary", "暂不修改");
  apply.onclick = async () => {
    apply.disabled = true;
    try {
      await inWorkspace(
        () => applyProposal(session, proposal, expected, baseRevision),
        "正在应用并保存修改…",
      );
    } catch (error) {
      toast(error.message);
      apply.disabled = false;
    }
  };
  reject.onclick = () => {
    clearPending();
    recordAction(session, "这组墙体或门窗调整未应用。");
  };
  box.append(ul, apply, reject);
  box.hidden = false;
  reject.scrollIntoView({ block: "nearest" });
}
$("chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (controller || workspaceLocked || !current?.ready) return;
  const message = $("chat-input").value.trim();
  if (!message) return;
  if (settings?.provider !== "codex" && !settings?.model) {
    openSettings();
    toast("先配置聊天模型，就可以在这里直接调整方案。");
    return;
  }
  if (pending) {
    toast("请先应用或取消上一组墙体修改");
    return;
  }
  const session = current;
  let assistant;
  const abort = new AbortController();
  controller = abort;
  setChatBusy(true);
  try {
    await saveNow(undefined, session);
    abort.signal.throwIfAborted();
    requireSession(session);
    const state = await rpc("state", undefined, session);
    abort.signal.throwIfAborted();
    if (state.gesture) throw new Error("请先结束当前拖动");
    const expected = JSON.stringify(state.plan),
      baseRevision = session.revision;
    $("messages").querySelector(".chat-welcome")?.remove();
    appendMessage("user", message);
    session.variant.messages.push({ role: "user", content: message });
    $("chat-input").value = "";
    fitComposer();
    $("chat-progress").textContent = "正在准备当前方案…";
    let streamed = "";
    const checks = await rpc("checks", undefined, session);
    abort.signal.throwIfAborted();
    const result = await readStream(
      session.endpoint("chat"),
      {
        message,
        revision: baseRevision,
        selection: state.selection,
        checks: checks.issues,
      },
      abort.signal,
      (event) => {
        if (current !== session) return;
        if (event.type === "status")
          $("chat-progress").textContent = event.text;
        if (event.type === "delta") {
          streamed += event.text;
          if (!assistant) assistant = appendMessage("assistant", "");
          assistant.querySelector(".message-content").textContent = streamed;
          assistant.scrollIntoView({ block: "end" });
        }
      },
    );
    abort.signal.throwIfAborted();
    if (current !== session) return;
    if (assistant)
      assistant.querySelector(".message-content").textContent = result.reply;
    else appendMessage("assistant", result.reply);
    session.variant.messages.push({ role: "assistant", content: result.reply });
    if (result.proposal) {
      if (result.proposal.structural)
        showProposal(session, result.proposal, expected, baseRevision);
      else
        await inWorkspace(
          () => applyProposal(session, result.proposal, expected, baseRevision),
          "正在应用并保存修改…",
        );
    }
  } catch (error) {
    if (current === session) {
      if (error.name === "AbortError")
        appendMessage(
          "assistant",
          "已停止，尚未应用的修改不会写入方案。",
          "action",
        );
      else appendMessage("assistant", error.message, "error");
    }
  } finally {
    if (controller === abort) {
      controller = null;
      setChatBusy(false);
      if (current === session && !workspaceLocked) $("chat-input").focus();
    }
  }
});
$("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("chat-form").requestSubmit();
  }
});
$("stop-chat").onclick = () => controller?.abort();
$("undo-ai").onclick = async () => {
  try {
    await inWorkspace(async (session) => {
      requireSession(session);
      await saveNow(undefined, session);
      const r = await rpc("undo", undefined, session);
      if (r.changed) {
        await saveNow("撤销", session);
        await recordAction(session, "已撤销上一步修改。");
        clearPending();
        showLayoutFeedback((await rpc("checks", undefined, session)).issues);
      } else toast("已经是当前会话的最早版本");
    });
  } catch (e) {
    toast(e.message);
  }
};
$("check-plan").onclick = async () => {
  try {
    const r = await rpc("checks");
    appendMessage(
      "assistant",
      r.issues.length
        ? "当前检查：\n" +
            r.issues
              .slice(0, 16)
              .map((i) => "· " + i.msg)
              .join("\n")
        : "当前设计器检查没有发现问题。尺寸和施工条件仍以现场核实为准。",
    );
  } catch (e) {
    toast(e.message);
  }
};
$("show-underlay").onclick = async () => {
  try {
    await rpc("view", "2d");
    const r = await rpc("underlay");
    toast(
      r.visible ? "已显示原始户型图，可在原编辑器中调整比例" : "已隐藏原图",
    );
  } catch (e) {
    toast(e.message);
  }
};
$("export-plan").onclick = async () => {
  try {
    await saveNow();
    const s = await rpc("state"),
      text = JSON.stringify(s.plan, null, 2);
    if (window.desktop) {
      if (await desktop.exportPlan({ name: s.plan.name, text }))
        toast("方案已导出");
    } else {
      const a = make("a");
      a.href = URL.createObjectURL(
        new Blob([text], { type: "application/json" }),
      );
      a.download = s.plan.name + ".json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
  } catch (e) {
    toast(e.message);
  }
};
$("home-button").onclick = () => goHome().catch((e) => toast(e.message));
window.desktop?.onHome(() => goHome().catch((e) => toast(e.message)));
$("save-status").onclick = () =>
  saveNow()
    .then(() => toast("已保存"))
    .catch((e) => toast(e.message));
$("variant-select").onchange = () => {
  const id = $("variant-select").value;
  loadProject(current.project.id, id).catch((e) => {
    if (current) $("variant-select").value = current.variant.id;
    toast(e.message);
  });
};
$("copy-variant").onclick = async () => {
  try {
    await inWorkspace(async (session) => {
      requireSession(session);
      controller?.abort();
      await saveNow(undefined, session);
      const next = await api(session.endpoint("copy"), {});
      await openProject(session.project.id, next.id);
    });
  } catch (e) {
    toast(e.message);
  }
};
function setChatVisible(visible) {
  $("chat-panel").hidden = !visible;
  $("toggle-chat").setAttribute("aria-expanded", String(visible));
}
$("toggle-chat").onclick = () => setChatVisible($("chat-panel").hidden);
$("close-chat").onclick = () => {
  setChatVisible(false);
  $("toggle-chat").focus();
};
async function loadSettings() {
  settings = await api("/api/settings");
  $("model-dot").classList.toggle(
    "ready",
    settings.provider === "api" && !!settings.model,
  );
  if (settings.provider === "codex") refreshCodex().catch(() => {});
}
function providerFields() {
  const isApi = $("model-provider").value === "api";
  $("api-settings").hidden = !isApi;
  $("codex-settings").hidden = isApi;
  $("base-url").required = isApi;
  $("chat-model").required = isApi;
}
function openSettings() {
  $("model-provider").value = settings?.provider || "codex";
  $("codex-model").value = settings?.codexModel || "";
  $("codex-path").value = settings?.codexPath || "";
  $("codex-effort").value = settings?.codexEffort || "medium";
  $("base-url").value = settings?.baseUrl || "https://api.openai.com/v1";
  $("chat-model").value = settings?.model || "";
  $("vision-model").value = settings?.visionModel || "";
  $("max-tokens").value = settings?.maxTokens || 6000;
  $("api-key").value = "";
  $("api-key").placeholder = settings?.hasKey
    ? "已有加密密钥；留空保留，输入可替换"
    : "输入 API 密钥；无密钥服务可留空";
  $("settings-result").textContent = "";
  providerFields();
  $("settings-dialog").showModal();
  refreshCodex().catch((e) => {
    $("codex-status").textContent = e.message;
  });
}
$("settings-button").onclick = openSettings;
$("model-provider").onchange = providerFields;
async function refreshCodex() {
  const status = await api("/api/codex/status");
  $("codex-status").textContent = status.message;
  $("codex-detail").textContent = status.available
    ? [status.version, status.account].filter(Boolean).join(" · ")
    : "可以指定本机程序路径，或切换到自定义 LLM API。";
  if (settings?.provider === "codex")
    $("model-dot").classList.toggle("ready", status.loggedIn);
  return status;
}
$("codex-refresh").onclick = async () => {
  try {
    settings = await api("/api/settings", settingsBody());
    await refreshCodex();
  } catch (e) {
    $("codex-status").textContent = e.message;
  }
};
$("codex-login").onclick = async () => {
  if (loginController) return;
  loginController = new AbortController();
  $("codex-login").disabled = true;
  $("codex-status").textContent = "正在准备登录…";
  try {
    settings = await api("/api/settings", settingsBody());
    await readStream(
      "/api/codex/login",
      {},
      loginController.signal,
      (event) => {
        if (event.type === "login") {
          loginUrl = event.url;
          $("codex-code").textContent = event.code;
          $("codex-auth").hidden = false;
          $("codex-status").textContent = "等待你在浏览器中登录";
        }
      },
    );
    await refreshCodex();
  } catch (e) {
    $("codex-status").textContent =
      e.name === "AbortError" ? "已取消登录" : e.message;
  } finally {
    loginController = null;
    $("codex-login").disabled = false;
    $("codex-auth").hidden = true;
  }
};
$("codex-open-auth").onclick = () => {
  if (window.desktop) desktop.openAuth(loginUrl);
  else toast("请在浏览器打开 " + loginUrl);
};
$("codex-cancel-login").onclick = () => loginController?.abort();
$("settings-dialog").addEventListener("close", () => loginController?.abort());
$("base-url").addEventListener("input", () => {
  if ($("base-url").value.replace(/\/$/, "") !== settings?.baseUrl) {
    $("api-key").value = "";
    $("api-key").placeholder = "服务地址已改变，请重新填写该服务的密钥";
  }
});
const settingsBody = () => ({
  provider: $("model-provider").value,
  codexPath: $("codex-path").value,
  codexModel: $("codex-model").value,
  codexEffort: $("codex-effort").value,
  baseUrl: $("base-url").value,
  apiKey: $("api-key").value,
  model: $("chat-model").value,
  visionModel: $("vision-model").value,
  maxTokens: Number($("max-tokens").value),
});
$("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    settings = await api("/api/settings", settingsBody());
    await loadSettings();
    $("settings-dialog").close();
    $("api-key").value = "";
    toast("模型设置已保存");
  } catch (error) {
    $("settings-result").textContent = error.message;
    $("settings-result").classList.add("error");
  }
});
$("test-model").onclick = async () => {
  if (!$("settings-form").reportValidity()) return;
  $("test-model").disabled = true;
  $("settings-result").classList.remove("error");
  $("settings-result").textContent = "正在连接模型…";
  try {
    const r = await api("/api/settings/test", { save: settingsBody() });
    await loadSettings();
    $("api-key").value = "";
    $("settings-result").textContent = "连接成功。聊天模型已响应。";
  } catch (e) {
    $("settings-result").textContent = e.message;
    $("settings-result").classList.add("error");
  } finally {
    $("test-model").disabled = false;
  }
};
for (const button of document.querySelectorAll("[data-close]"))
  button.onclick = () => {
    if (button.dataset.close === "import-dialog" && controller) {
      controller.abort();
      controller = null;
    }
    $(button.dataset.close).close();
  };
$("new-project").onclick = () => {
  if (
    settings?.provider !== "codex" &&
    !settings?.model &&
    !settings?.visionModel
  ) {
    openSettings();
    toast("先设置一个支持图片输入的模型，然后导入户型图。");
    return;
  }
  $("import-dialog").showModal();
};
$("import-dialog").addEventListener("cancel", () => controller?.abort());
async function acceptImage(file) {
  if (!file || !["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw new Error("请选择 PNG、JPG 或 WebP 图片");
  if (file.size > 30_000_000) throw new Error("图片超过 30 MB，请先缩小");
  const bitmap = await createImageBitmap(file),
    ratio = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height)),
    canvas = make("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
  canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  selectedImage = {
    dataUrl: canvas.toDataURL("image/jpeg", 0.92),
    width: canvas.width,
    height: canvas.height,
  };
  $("image-preview").src = selectedImage.dataUrl;
  $("image-preview").hidden = false;
  $("drop-placeholder").hidden = true;
  $("import-result").textContent = "";
}
$("drop-zone").addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    $("floorplan-file").click();
  }
});
$("floorplan-file").onchange = () =>
  acceptImage($("floorplan-file").files[0]).catch((e) => toast(e.message));
for (const event of ["dragenter", "dragover"])
  $("drop-zone").addEventListener(event, (e) => {
    e.preventDefault();
    $("drop-zone").classList.add("dragover");
  });
for (const event of ["dragleave", "drop"])
  $("drop-zone").addEventListener(event, (e) => {
    e.preventDefault();
    $("drop-zone").classList.remove("dragover");
    if (event === "drop")
      acceptImage(e.dataTransfer.files[0]).catch((error) =>
        toast(error.message),
      );
  });
$("import-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (controller) return;
  if (!selectedImage) {
    toast("请先选择户型图");
    return;
  }
  const abort = new AbortController();
  controller = abort;
  $("generate-button").disabled = true;
  $("cancel-generate").hidden = false;
  $("import-result").classList.remove("error");
  try {
    const result = await readStream(
      "/api/generate",
      {
        image: selectedImage,
        brief: $("design-brief").value,
        height: Math.round(Number($("ceiling-height").value) * 1000),
        widthMeters: $("known-width").value
          ? Number($("known-width").value)
          : undefined,
        schemeCount: Number($("scheme-count").value),
      },
      abort.signal,
      (event) => {
        if (event.type === "status")
          $("import-result").textContent = event.text;
      },
    );
    controller = null;
    $("import-dialog").close();
    await loadProject(result.projectId);
    toast("设计方案已生成。先查看 3D，再核对尺寸与原图。");
  } catch (error) {
    $("import-result").textContent =
      error.name === "AbortError" ? "已停止生成。" : error.message;
    $("import-result").classList.add("error");
  } finally {
    if (controller === abort) controller = null;
    $("generate-button").disabled = false;
    $("cancel-generate").hidden = true;
  }
});
$("cancel-generate").onclick = () => controller?.abort();
$("import-plan").onclick = () => $("plan-file").click();
$("plan-file").onchange = async () => {
  try {
    const f = $("plan-file").files[0];
    if (!f) return;
    if (f.size > 16_000_000) throw new Error("方案文件超过 16 MB");
    const plan = JSON.parse(await f.text());
    const p = await api("/api/import", { plan });
    await loadProject(p.id);
  } catch (e) {
    toast(e.message);
  } finally {
    $("plan-file").value = "";
  }
};
window.desktop?.onClose(async () => {
  controller?.abort();
  try {
    if (workspacePromise) await workspacePromise;
    await inWorkspace(async (session) => {
      await saveNow(undefined, session);
      desktop.closeReady();
    });
  } catch (e) {
    if (
      confirm(
        "保存未完成：" + e.message + "\n仍然退出吗？未保存的编辑可能丢失。",
      )
    )
      desktop.closeReady();
  }
});
await loadSettings().catch((e) => toast(e.message));
await renderProjects().catch((e) => toast(e.message));
