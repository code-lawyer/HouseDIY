import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { createStore, Conflict } from "./store.mjs";
import { chat, testConnection, recognize } from "./ai.mjs";
import { codexStatus, codexLogin } from "./codex.mjs";
import { string, number, validatePlan } from "./model.mjs";

const base = new URL("../", import.meta.url);
const template = readFileSync(new URL("vendor/designer.html", base), "utf8");
const license = readFileSync(
  new URL("vendor/HOUSE-PLAN-DESIGNER-LICENSE", base),
  "utf8",
);
const encode = (v) => JSON.stringify(v).replaceAll("<", "\\u003c");
function editorHtml(project, variant) {
  let html = template
    .replace(/<script id="__preset">.*?<\/script>/s, "")
    .replace(
      'location.search.includes("debug")&&(window.__designer=',
      "true&&(window.__designer=",
    )
    // The desktop store is authoritative; never restore a stale browser cache.
    .replace("function JL(){", "function JL(){return null;");
  const preset = {
    id: `housediy-${project.id}-${variant.id}`,
    plan: variant.plan,
    underlay: project.underlay,
  };
  const payload = `<script id="__preset">window.__PRESET__=${encode(preset)};window.__HOUSEDIY__=${encode({ projectId: project.id, variantId: variant.id })}</script>`;
  html = html
    .replace(/<meta charset[^>]*>/i, (m) => m + payload)
    .replace(
      "</head>",
      '<link rel="stylesheet" href="/design-tokens.css"><link rel="stylesheet" href="/editor-theme.css"></head>',
    )
    .replace(
      "</body>",
      '<script src="/editor-workspace.js"></script><script src="/editor-bridge.js"></script></body>',
    );
  return html + "\n<!--\n" + license + "\n-->";
}
export async function startServer({
  dataDir,
  secretCodec,
  port = 0,
  seedFile,
} = {}) {
  const store = createStore(dataDir, secretCodec);
  store.ensureDemo(seedFile);
  const token = randomBytes(32).toString("hex");
  let origin;
  const json = (res, status, data) =>
    res
      .writeHead(status, { "content-type": "application/json;charset=utf-8" })
      .end(JSON.stringify(data));
  async function body(req) {
    if (!/^application\/json(?:;|$)/.test(req.headers["content-type"] ?? "")) {
      const e = new Error("需要 JSON 请求");
      e.status = 415;
      throw e;
    }
    let size = 0,
      chunks = [];
    for await (const b of req) {
      size += b.length;
      if (size > 16_000_000)
        throw new Error("上传内容超过 16 MB，请压缩图片后重试");
      chunks.push(b);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Error("请求内容不是有效 JSON");
    }
  }
  const stream = async (req, res, work) => {
    const controller = new AbortController();
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
    const url = new URL(req.url, origin);
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
      if (req.method === "GET" && path === "/api/codex/status")
        return json(res, 200, await codexStatus(store.publicSettings()));
      if (req.method === "POST" && path === "/api/codex/login") {
        await body(req);
        return stream(req, res, async (signal, emit) => ({
          status: await codexLogin(store.publicSettings(), { signal, emit }),
        }));
      }
      if (req.method === "GET" && path === "/api/projects")
        return json(res, 200, store.list());
      if (req.method === "POST" && path === "/api/import") {
        const b = await body(req),
          plan = validatePlan(b.plan?.plan ?? b.plan);
        return json(
          res,
          200,
          store.create({
            name: b.name || plan.name,
            variants: [
              { name: plan.name, plan, description: "从方案文件导入" },
            ],
            assumptions: ["已导入已有模型，尺寸与承重信息以原方案为准。"],
          }),
        );
      }
      if (req.method === "POST" && path === "/api/generate") {
        const b = await body(req);
        const image = b.image;
        if (
          !image ||
          !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(
            image.dataUrl ?? "",
          )
        )
          throw new Error("请上传 PNG、JPG 或 WebP 户型图");
        number(image.width, "图片宽度", 64, 2400);
        number(image.height, "图片高度", 64, 2400);
        const options = {
          name: b.name,
          brief: typeof b.brief === "string" ? b.brief.slice(0, 4000) : "",
          height: number(b.height ?? 2800, "层高", 1800, 12000),
          schemeCount: number(b.schemeCount ?? 3, "方案数量", 1, 3),
          widthMeters: b.widthMeters
            ? number(b.widthMeters, "户型跨度", 1, 100)
            : undefined,
        };
        return stream(req, res, async (signal, emit) => {
          const result = await recognize({
            settings: await store.credentials(),
            image,
            options,
            signal,
            emit,
          });
          if (signal.aborted) throw new Error("已停止");
          const p = store.create({ ...result, image });
          return { projectId: p.id };
        });
      }
      let m = path.match(/^\/api\/projects\/([a-f0-9]{16})$/);
      if (req.method === "GET" && m) return json(res, 200, store.get(m[1]));
      m = path.match(
        /^\/api\/projects\/([a-f0-9]{16})\/variants\/([a-f0-9]{16})\/(save|chat|copy|note)$/,
      );
      if (req.method === "POST" && m) {
        const [, pid, vid, action] = m,
          b = await body(req);
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
        return stream(req, res, async (signal, emit) => {
          const result = await chat({
            settings: await store.credentials(),
            plan: v.plan,
            selection: b.selection,
            checks: b.checks,
            messages: oldMessages,
            message,
            signal,
            emit,
          });
          if (signal.aborted) throw new Error("已停止");
          if (store.variant(pid, vid).v.revision !== b.revision)
            throw new Conflict();
          store.addMessages(pid, vid, [
            { role: "assistant", content: result.reply, at: Date.now() },
          ]);
          return { ...result, baseRevision: b.revision };
        });
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
        "/style.css": "style.css",
        "/design-tokens.css": "design-tokens.css",
        "/editor-theme.css": "editor-theme.css",
        "/editor-workspace.js": "editor-workspace.js",
        "/editor-bridge.js": "editor-bridge.js",
        "/logo.svg": "logo.svg",
        "/fonts/noto-sans-sc.ttf": "fonts/noto-sans-sc.ttf",
      };
      const icon = path.match(/^\/icons\/([a-z-]+)\.svg$/);
      if (icon) staticFiles[path] = `icons/${icon[1]}.svg`;
      if (req.method === "GET" && staticFiles[path]) {
        const name = staticFiles[path],
          type = name.endsWith(".css")
            ? "text/css"
            : name.endsWith(".js")
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
