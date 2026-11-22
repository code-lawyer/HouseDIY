import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { createStore, Conflict } from "./store.mjs";
import { chat, testConnection, recognize } from "./ai.mjs";
import { agentStatus } from "./agents.mjs";
import { string, number, validatePlan } from "./model.mjs";
import { requireDesignReview } from "./design-rules.mjs";

import { editorHtml } from "./editor-template.mjs";
import { createModelLibrary, maxPlanFileBytes } from "./model-assets.mjs";
import { createShapeLibrary } from "./shape-library.mjs";

const base = new URL("../", import.meta.url);
const originalImageLimit = 40_000_000;
const imageData = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/;
function publicProject(project) {
  if (!project.image?.originalDataUrl) return project;
  const { originalDataUrl, ...image } = project.image;
  return {
    ...project,
    image: { ...image, originalAvailable: !!originalDataUrl },
  };
}
export async function startServer({
  dataDir,
  secretCodec,
  port = 0,
  seedFile,
} = {}) {
  const store = createStore(dataDir, secretCodec);
  const models = createModelLibrary(store.directory);
  const shapes = createShapeLibrary(store.directory);
  store.ensureDemo(seedFile);
  try {
    models.pruneUnreferenced(new Set(), store.referencedModels);
  } catch {
    // Preserve an unreadable cleanup queue and keep the projects accessible.
  }
  const token = randomBytes(32).toString("hex");
  let origin;
  // Cover the gap between writing attachment bytes and saving their project or library entry.
  let modelChanges = Promise.resolve();
  function withModelChanges(task) {
    const result = modelChanges.then(task);
    modelChanges = result.catch(() => {});
    return result;
  }
  const projectRequests = new Map();
  const json = (res, status, data) =>
    res
      .writeHead(status, { "content-type": "application/json;charset=utf-8" })
      .end(JSON.stringify(data));
  async function body(req, limit = 16_000_000) {
    if (!/^application\/json(?:;|$)/.test(req.headers["content-type"] ?? "")) {
      const e = new Error("需要 JSON 请求");
      e.status = 415;
      throw e;
    }
    let size = 0,
      chunks = [];
    for await (const b of req) {
      size += b.length;
      if (size > limit)
        throw new Error("上传内容超过 " + limit / 1_000_000 + " MB");
      chunks.push(b);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Error("请求内容不是有效 JSON");
    }
  }
  const stream = async (req, res, work, projectId) => {
    const controller = new AbortController();
    if (projectId) {
      if (!projectRequests.has(projectId))
        projectRequests.set(projectId, new Set());
      projectRequests.get(projectId).add(controller);
    }
    res.on("close", () => controller.abort());
    res.writeHead(200, {
      "content-type": "text/event-stream;charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.flushHeaders();
    const emit = (data) => {
      if (!res.destroyed) res.write("data: " + JSON.stringify(data) + "\n\n");
    };
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(": keepalive\n\n");
    }, 15000);
    try {
      const result = await work(controller.signal, emit);
      if (controller.signal.aborted) return;
      emit({ type: "result", ...result });
    } catch (error) {
      emit({
        type: "error",
        message: error.message,
        status: error.status || 400,
      });
    } finally {
      if (projectId) {
        projectRequests.get(projectId)?.delete(controller);
        if (!projectRequests.get(projectId)?.size)
          projectRequests.delete(projectId);
      }
      clearInterval(heartbeat);
      res.end();
    }
  };
  const server = createServer(async (req, res) => {
    const nonce = randomBytes(18).toString("base64");
    const nonceHtml = (html) =>
      html.replace(/<script\b/g, `<script nonce="${nonce}"`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self' 'nonce-${nonce}' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' blob:; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'`,
    );
    if (
      req.headers.host !== new URL(origin).host ||
      (req.headers.origin && req.headers.origin !== origin) ||
      (req.headers["sec-fetch-site"] &&
        !["same-origin", "none"].includes(req.headers["sec-fetch-site"]))
    )
      return json(res, 403, { error: "只允许当前桌面应用访问" });
    let url;
    try {
      url = new URL(req.url, origin);
    } catch {
      return json(res, 400, { error: "请求地址无效" });
    }
    if (
      req.method === "GET" &&
      url.pathname === "/bootstrap" &&
      url.searchParams.get("token") === token
    ) {
      res.setHeader(
        "Set-Cookie",
        `housediy_session=${token}; HttpOnly; SameSite=Strict; Path=/`,
      );
      res.writeHead(302, { Location: "/" }).end();
      return;
    }
    const authorized =
      (req.headers.cookie ?? "")
        .split(";")
        .some((x) => x.trim() === `housediy_session=${token}`) ||
      req.headers.authorization === `Bearer ${token}`;
    if (!authorized)
      return json(res, 401, { error: "请从 HouseDIY 桌面应用打开" });
    try {
      const path = url.pathname;
      if (req.method === "GET" && path === "/api/models")
        return json(res, 200, await models.list());
      if (path === "/api/shapes") {
        if (req.method === "GET") return json(res, 200, shapes.read());
        if (req.method === "POST")
          return json(res, 200, shapes.replace(await body(req, 4_000_000)));
      }
      const modelPath = path.match(/^\/api\/models\/([a-z0-9_-]{1,80})$/);
      if (modelPath) {
        const id = modelPath[1];
        if (req.method === "GET") return json(res, 200, await models.read(id));
        if (req.method === "PUT") {
          const input = await body(req, maxPlanFileBytes);
          await withModelChanges(() =>
            models.put(id, input, { repair: input?.repair === true }),
          );
          return json(res, 200, { ok: true });
        }
        if (req.method === "DELETE") {
          await withModelChanges(() => models.remove(id));
          return json(res, 200, { ok: true });
        }
      }
      const exportPath = path.match(
        /^\/api\/projects\/([a-f0-9]{16})\/variants\/([a-f0-9]{16})\/export$/,
      );
      if (req.method === "GET" && exportPath) {
        const { v } = store.variant(exportPath[1], exportPath[2]);
        return json(res, 200, await models.forExport(v.plan));
      }
      if (req.method === "GET" && path === "/api/settings")
        return json(res, 200, store.publicSettings());
      if (req.method === "POST" && path === "/api/settings")
        return json(res, 200, await store.setSettings(await body(req)));
      if (req.method === "POST" && path === "/api/settings/test") {
        const input = await body(req);
        if (input.save) await store.setSettings(input.save);
        const controller = new AbortController();
        res.on("close", () => controller.abort());
        const s = await store.credentials();
        const r = await testConnection(s, controller.signal);
        return json(res, 200, {
          ok: true,
          message: (r.reply ?? "已连接").slice(0, 120),
        });
      }
      if (req.method === "POST" && path === "/api/agent/status") {
        const input = await body(req);
        const controller = new AbortController();
        res.on("close", () => controller.abort());
        return json(
          res,
          200,
          await agentStatus(input.agent, input.config, controller.signal),
        );
      }
      if (
        req.method === "GET" &&
        ["/api/projects", "/api/trash"].includes(path)
      ) {
        const deleted = path === "/api/trash";
        const withDiagnostics = url.searchParams.get("diagnostics") === "1";
        const catalog = store.catalog(deleted, withDiagnostics && !deleted);
        return json(res, 200, withDiagnostics ? catalog : catalog.projects);
      }
      if (req.method === "POST" && path === "/api/trash/purge") {
        const input = await body(req);
        const result = await withModelChanges(() => {
          const { modelIds, ...counts } = store.purgeTrash(input?.projects);
          // Project mutations cannot interleave with the synchronous reference check and pruning.
          try {
            const cleanupDeferred = models.pruneUnreferenced(
              modelIds,
              store.referencedModels,
            );
            return { ...counts, ...(cleanupDeferred && { cleanupDeferred }) };
          } catch {
            return { ...counts, cleanupQueueError: true };
          }
        });
        return json(res, 200, result);
      }
      const projectAction = path.match(
        /^\/api\/projects\/([a-f0-9]{16})\/(trash|restore|preferences)$/,
      );
      if (req.method === "POST" && projectAction) {
        const [, pid, action] = projectAction,
          b = await body(req);
        if (action === "restore")
          return json(res, 200, publicProject(store.restore(pid, b.lifecycle)));
        if (action === "preferences")
          return json(res, 200, store.setDesignPreferences(pid, b));
        const result = store.trash(pid, b.lifecycle);
        for (const controller of projectRequests.get(pid) ?? [])
          controller.abort();
        return json(res, 200, result);
      }
      if (req.method === "POST" && path === "/api/import") {
        const b = await body(req, maxPlanFileBytes + 4096),
          plan = validatePlan(b.plan?.plan ?? b.plan);
        const project = await withModelChanges(async () => {
          await models.importFor(plan, b.plan?.models);
          return store.create({
            name: b.name || plan.name,
            variants: [
              { name: plan.name, plan, description: "从方案文件导入" },
            ],
            assumptions: ["已导入已有模型，尺寸与承重信息以原方案为准。"],
          });
        });
        return json(res, 200, project);
      }
      if (req.method === "POST" && path === "/api/generate") {
        const b = await body(req, 46_000_000);
        let source;
        if (b.projectId) {
          source = store.assertLifecycle(b.projectId, b.lifecycle);
          if (!source.imageImport)
            throw new Conflict("这个项目已完成识别，请打开当前方案。");
          if (b.copySource === true)
            source = store.createImageDraft(
              source.image,
              source.imageImport.options,
            );
          else if (
            source.imageImport.edited ||
            source.variants.length !== 1 ||
            source.variants[0].messages.length
          )
            throw new Conflict("当前底图中已有编辑，请用原图另建识别项目。");
        } else {
          const image = b.image;
          if (
            !image ||
            typeof image.dataUrl !== "string" ||
            image.dataUrl.length > 5_000_000 ||
            !imageData.test(image.dataUrl)
          )
            throw new Error("请上传 PNG、JPG 或 WebP 户型图");
          if (
            image.originalDataUrl != null &&
            (typeof image.originalDataUrl !== "string" ||
              image.originalDataUrl.length > originalImageLimit + 32 ||
              !imageData.test(image.originalDataUrl))
          )
            throw new Error("原始图片必须是 30 MB 以内的 PNG、JPG 或 WebP");
          number(image.width, "图片宽度", 1, 2400);
          number(image.height, "图片高度", 1, 2400);
          const schemeCount = number(b.schemeCount ?? 3, "方案数量", 1, 3);
          if (!Number.isInteger(schemeCount))
            throw new Error("方案数量必须为 1–3 的整数");
          const options = {
            name: typeof b.name === "string" ? b.name.trim().slice(0, 180) : "",
            brief: typeof b.brief === "string" ? b.brief.slice(0, 4000) : "",
            height: number(b.height ?? 2800, "层高", 1800, 12000),
            schemeCount,
            widthMeters:
              b.widthMeters == null
                ? undefined
                : number(b.widthMeters, "户型跨度", 1, 100),
          };
          source = store.createImageDraft(
            {
              dataUrl: image.dataUrl,
              width: image.width,
              height: image.height,
              ...(image.originalDataUrl && {
                originalDataUrl: image.originalDataUrl,
                originalName:
                  typeof image.originalName === "string"
                    ? image.originalName.slice(0, 200)
                    : "",
              }),
            },
            options,
          );
        }
        const projectId = source.id;
        return stream(
          req,
          res,
          async (signal, emit) => {
            emit({ type: "source", projectId, text: "原图草稿已保存" });
            if (b.manualOnly === true)
              return { projectId, draftStatus: "underlay" };
            let recognized, savedVariants, savedStatus, checkpointError;
            try {
              recognized = await recognize({
                settings: await store.credentials(),
                image: source.image,
                options: source.imageImport.options,
                signal,
                emit,
                onDraft: (draft, status) => {
                  signal.throwIfAborted();
                  try {
                    source = store.finishImageDraft(source, draft);
                  } catch (error) {
                    checkpointError = error;
                    throw error;
                  }
                  savedVariants = draft.variants;
                  savedStatus = status;
                },
              });
            } catch (error) {
              signal.throwIfAborted();
              if (error === checkpointError || error instanceof Conflict)
                throw error;
              if (savedVariants) return { projectId, draftStatus: savedStatus };
              store.finishImageDraft(
                source,
                null,
                String(error.message).slice(0, 600),
              );
              return { projectId, draftStatus: "underlay" };
            }
            signal.throwIfAborted();
            if (recognized.variants !== savedVariants)
              store.finishImageDraft(source, recognized);
            return { projectId, draftStatus: recognized.draftStatus };
          },
          projectId,
        );
      }
      let m = path.match(/^\/api\/projects\/([a-f0-9]{16})$/);
      if (req.method === "GET" && m)
        return json(res, 200, publicProject(store.get(m[1])));
      m = path.match(/^\/api\/projects\/([a-f0-9]{16})\/source$/);
      if (req.method === "GET" && m) {
        const image = store.get(m[1]).image;
        const source = image?.originalDataUrl?.match(imageData);
        if (!source)
          return json(res, 404, { error: "这个项目仅有用于描图的底图副本" });
        const extension = source[1] === "jpeg" ? "jpg" : source[1];
        const filename = encodeURIComponent(
          image.originalName || "floorplan." + extension,
        ).replaceAll("'", "%27");
        return res
          .writeHead(200, {
            "Content-Type": "image/" + source[1],
            "Content-Disposition":
              'attachment; filename="floorplan.' +
              extension +
              "\"; filename*=UTF-8''" +
              filename,
          })
          .end(Buffer.from(source[2], "base64"));
      }
      m = path.match(
        /^\/api\/projects\/([a-f0-9]{16})\/variants\/([a-f0-9]{16})\/(save|chat|copy|note|review)$/,
      );
      if (req.method === "POST" && m) {
        const [, pid, vid, action] = m,
          b = await body(req);
        const project = store.assertLifecycle(pid, b.lifecycle);
        if (action === "review") {
          const { v } = store.variant(pid, vid);
          if (v.revision !== b.revision) throw new Conflict();
          return json(
            res,
            200,
            requireDesignReview(
              v.plan,
              validatePlan(b.plan),
              project.designPreferences,
            ),
          );
        }
        if (action === "save")
          return json(
            res,
            200,
            store.commit(
              pid,
              vid,
              b.revision,
              b.plan,
              typeof b.description === "string"
                ? b.description.slice(0, 200)
                : "手动编辑",
              b.underlay,
              b.expectedUnderlayVersion,
            ),
          );
        if (action === "copy")
          return json(res, 200, store.cloneVariant(pid, vid, b.name));
        if (action === "note") {
          store.addMessages(pid, vid, [
            {
              role: "assistant",
              content: string(b.content, "消息", 3000),
              at: Date.now(),
              kind: "action",
            },
          ]);
          return json(res, 200, { ok: true });
        }
        const { v } = store.variant(pid, vid);
        if (v.revision !== b.revision) throw new Conflict();
        const message = string(b.message, "需求", 6000);
        const oldMessages = v.messages;
        store.addMessages(pid, vid, [
          { role: "user", content: message, at: Date.now() },
        ]);
        return stream(
          req,
          res,
          async (signal, emit) => {
            const result = await chat({
              settings: await store.credentials(),
              plan: v.plan,
              selection: b.selection,
              checks: b.checks,
              preferences: project.designPreferences,
              assumptions: project.assumptions,
              messages: oldMessages,
              message,
              signal,
              emit,
            });
            if (signal.aborted) throw new Error("已停止");
            const latest = store.assertLifecycle(pid, project.lifecycle);
            if (
              JSON.stringify(latest.designPreferences) !==
              JSON.stringify(project.designPreferences)
            )
              throw new Conflict("设计范围已变化，请按新的范围重新提出需求");
            if (store.variant(pid, vid).v.revision !== b.revision)
              throw new Conflict();
            store.addMessages(pid, vid, [
              { role: "assistant", content: result.reply, at: Date.now() },
            ]);
            return { ...result, baseRevision: b.revision };
          },
          pid,
        );
      }
      m = path.match(/^\/editor\/([a-f0-9]{16})\/([a-f0-9]{16})$/);
      if (req.method === "GET" && m) {
        const { p, v } = store.variant(m[1], m[2]);
        return res
          .writeHead(200, { "content-type": "text/html;charset=utf-8" })
          .end(nonceHtml(editorHtml(p, v)));
      }
      const staticFiles = {
        "/": "index.html",
        "/app.js": "app.js",
        "/startup.js": "startup.js",
        "/editor-session.js": "editor-session.js",
        "/design-rules.js": "../src/design-rules.mjs",
        "/opening-placement.js": "../src/opening-placement.mjs",
        "/editor-recovery.js": "editor-recovery.js",
        "/style.css": "style.css",
        "/design-tokens.css": "design-tokens.css",
        "/editor-theme.css": "editor-theme.css",
        "/editor-workspace.js": "editor-workspace.js",
        "/editor-bridge.js": "editor-bridge.js",
        "/editor-models.js": "editor-models.js",
        "/editor-shapes.js": "editor-shapes.js",
        "/logo.svg": "logo.svg",
        "/fonts/noto-sans-sc.ttf": "fonts/noto-sans-sc.ttf",
      };
      const icon = path.match(/^\/icons\/([a-z-]+)\.svg$/);
      if (icon) staticFiles[path] = `icons/${icon[1]}.svg`;
      if (req.method === "GET" && staticFiles[path]) {
        const name = staticFiles[path],
          type = name.endsWith(".css")
            ? "text/css"
            : /\.m?js$/.test(name)
              ? "text/javascript"
              : name.endsWith(".ttf")
                ? "font/ttf"
                : name.endsWith(".svg")
                  ? "image/svg+xml"
                  : "text/html",
          content = readFileSync(new URL("public/" + name, base));
        return res
          .writeHead(200, { "content-type": type + ";charset=utf-8" })
          .end(
            type === "text/html"
              ? nonceHtml(content.toString("utf8"))
              : content,
          );
      }
      return json(res, 404, { error: "找不到此页面" });
    } catch (error) {
      return json(res, error.status || 400, { error: error.message });
    }
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  origin = "http://127.0.0.1:" + server.address().port;
  return {
    server,
    origin,
    token,
    store,
    url: origin + "/bootstrap?token=" + token,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
