import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import {
  id,
  revision,
  validatePlan,
  string,
  number,
  demoPlan,
} from "./model.mjs";

function validateUnderlay(value) {
  if (value === null) return null;
  if (
    !value ||
    !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(
      value.src ?? "",
    )
  )
    throw new Error("原图格式无效");
  return {
    src: value.src,
    imgW: number(value.imgW, "原图宽度", 1, 30000),
    imgH: number(value.imgH, "原图高度", 1, 30000),
    mmPerPx: number(value.mmPerPx, "原图比例", 0.01, 10000),
    x: number(value.x, "原图 X"),
    y: number(value.y, "原图 Y"),
    opacity: number(value.opacity ?? 0.5, "原图透明度", 0, 1),
    visible: !!value.visible,
    locked: !!value.locked,
  };
}

export class Conflict extends Error {
  constructor(message = "方案已有新的手动修改，请重新发送这条需求。") {
    super(message);
    this.status = 409;
  }
}
export const atomic = (file, value) => {
  const temp = file + "." + id() + ".tmp";
  writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
  renameSync(temp, file);
};
export function createStore(directory, secretCodec) {
  mkdirSync(join(directory, "projects"), { recursive: true });
  const read = (file, fallback) => {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return fallback;
      throw error;
    }
  };
  const projectPath = (projectId) => {
    if (!/^[a-f0-9]{16}$/.test(projectId)) throw new Error("项目 ID 无效");
    return join(directory, "projects", projectId + ".json");
  };
  const settingsPath = join(directory, "settings.json");
  const defaults = {
    provider: "codex",
    codexPath: "",
    codexModel: "",
    codexEffort: "medium",
    baseUrl: "https://api.openai.com/v1",
    model: "",
    visionModel: "",
    maxTokens: 6000,
  };
  const settings = () => {
    const saved = read(settingsPath, null);
    return {
      ...defaults,
      ...saved,
      ...(saved && !saved.provider ? { provider: "api" } : {}),
    };
  };
  const list = () =>
    readdirSync(join(directory, "projects"))
      .filter((x) => x.endsWith(".json"))
      .map((file) => read(join(directory, "projects", file)))
      .map((p) => ({
        id: p.id,
        name: p.name,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        variantCount: p.variants.length,
        variants: p.variants.map((v) => ({
          id: v.id,
          name: v.name,
          description: v.description,
        })),
        hasImage: !!p.image,
        assumptions: p.assumptions,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  const get = (projectId) => {
    const p = read(projectPath(projectId));
    if (!p) {
      const e = new Error("项目不存在");
      e.status = 404;
      throw e;
    }
    // Normalize legacy plans before serving both the shell and the editor.
    // Persist with the next normal save; opening a project keeps its timestamp.
    for (const v of p.variants)
      for (const entry of [v, ...(v.history ?? [])])
        if (entry.plan.walls.some((w) => w.status === "demolish")) {
          entry.plan = validatePlan(entry.plan);
          entry.revision = revision(entry.plan);
        }
    return p;
  };
  const save = (p) => {
    p.updatedAt = Date.now();
    atomic(projectPath(p.id), p);
    return p;
  };
  const makeVariant = ({ name, description = "", plan }) => {
    const valid = validatePlan(plan);
    return {
      id: id(),
      name: string(name ?? valid.name, "方案名称"),
      description,
      plan: valid,
      revision: revision(valid),
      messages: [],
      history: [],
    };
  };
  return {
    directory,
    list,
    get,
    save,
    publicSettings() {
      const { encryptedKey, ...s } = settings();
      return {
        ...s,
        hasKey: !!encryptedKey,
        credentialError:
          encryptedKey && !secretCodec ? "当前系统无法读取保存的密钥" : "",
      };
    },
    async credentials() {
      const s = settings();
      return {
        ...s,
        runtimeDir: join(directory, "requests"),
        apiKey:
          s.provider === "api" && s.encryptedKey
            ? await secretCodec.decrypt(s.encryptedKey)
            : "",
      };
    },
    async setSettings(body) {
      const prior = settings();
      let url;
      try {
        url = new URL(string(body.baseUrl ?? prior.baseUrl, "API 地址", 600));
      } catch {
        throw new Error("请输入完整的 API 地址，例如 https://服务地址/v1");
      }
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("API 地址必须是 HTTP(S)，不能包含账号、查询参数或片段");
      const baseUrl = url.href
        .replace(/\/$/, "")
        .replace(/\/chat\/completions$/, "");
      const next = {
        baseUrl,
        provider: body.provider === "api" ? "api" : "codex",
        codexPath:
          typeof body.codexPath === "string"
            ? body.codexPath.trim().slice(0, 1000)
            : prior.codexPath,
        codexModel:
          typeof body.codexModel === "string"
            ? body.codexModel.trim().slice(0, 150)
            : prior.codexModel,
        codexEffort: ["low", "medium", "high"].includes(body.codexEffort)
          ? body.codexEffort
          : prior.codexEffort,
        model:
          typeof body.model === "string"
            ? body.model.trim().slice(0, 150)
            : prior.model,
        visionModel:
          typeof body.visionModel === "string"
            ? body.visionModel.trim().slice(0, 150)
            : prior.visionModel,
        maxTokens: Math.min(
          16000,
          Math.max(1000, Number(body.maxTokens) || prior.maxTokens),
        ),
      };
      if (prior.baseUrl === baseUrl && !body.clearKey)
        next.encryptedKey = prior.encryptedKey;
      if (body.apiKey) {
        if (!secretCodec) throw new Error("系统密钥存储不可用");
        if (typeof body.apiKey !== "string" || body.apiKey.length > 4096)
          throw new Error("密钥格式不正确");
        next.encryptedKey = await secretCodec.encrypt(body.apiKey);
      }
      atomic(settingsPath, next);
      return this.publicSettings();
    },
    create({
      name,
      variants,
      image = null,
      underlay = null,
      assumptions = [],
    }) {
      if (!Array.isArray(variants) || !variants.length || variants.length > 12)
        throw new Error("项目需要 1–12 个方案");
      const p = {
        id: id(),
        name: string(name, "项目名称"),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        image,
        underlay,
        assumptions: assumptions
          .filter((x) => typeof x === "string")
          .slice(0, 30),
        variants: variants.map(makeVariant),
      };
      return save(p);
    },
    variant(projectId, variantId) {
      const p = get(projectId),
        v = p.variants.find((v) => v.id === variantId);
      if (!v) throw new Error("该设计方案不存在");
      return { p, v };
    },
    commit(
      projectId,
      variantId,
      expected,
      plan,
      description = "手动编辑",
      underlay,
    ) {
      const { p, v } = this.variant(projectId, variantId);
      if (v.revision !== expected) throw new Conflict();
      const valid = validatePlan(plan),
        hash = revision(valid);
      if (underlay !== undefined) p.underlay = validateUnderlay(underlay);
      if (hash === v.revision) {
        if (underlay !== undefined) save(p);
        return { revision: v.revision, plan: v.plan, underlay: p.underlay };
      }
      v.history.push({
        at: Date.now(),
        description,
        plan: v.plan,
        revision: v.revision,
      });
      v.history = v.history.slice(-30);
      v.plan = valid;
      v.revision = hash;
      save(p);
      return { revision: hash, plan: valid, underlay: p.underlay };
    },
    addMessages(projectId, variantId, messages) {
      const { p, v } = this.variant(projectId, variantId);
      v.messages.push(...messages);
      v.messages = v.messages.slice(-120);
      save(p);
    },
    cloneVariant(projectId, variantId, name) {
      const { p, v } = this.variant(projectId, variantId);
      if (p.variants.length >= 12)
        throw new Error("此项目已达到 12 个方案，请新建项目");
      const next = makeVariant({
        name: name || v.name + " · 副本",
        description: v.description,
        plan: v.plan,
      });
      next.plan.name = next.name;
      next.revision = revision(next.plan);
      p.variants.push(next);
      save(p);
      return next;
    },
    ensureDemo(seedFile) {
      if (list().length) return;
      if (seedFile && existsSync(seedFile)) {
        try {
          const raw = read(seedFile),
            plan = raw.plan ?? raw;
          this.create({
            name: plan.name,
            variants: [
              {
                name: plan.name,
                description: "从已有本地方案导入的副本。",
                plan,
              },
            ],
            assumptions: ["该方案从本机文件导入，原文件保持不变。"],
          });
          return;
        } catch (error) {
          console.warn("Existing project import skipped:", error.message);
        }
      }
      const plan = demoPlan();
      this.create({
        name: "日光客厅 · 示例",
        variants: [
          {
            name: plan.name,
            description: "可以先体验拖动家具、切换 3D，再配置 AI。",
            plan,
          },
        ],
        assumptions: [],
      });
    },
  };
}
