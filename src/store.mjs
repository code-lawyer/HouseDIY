import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  existsSync,
  rmSync,
  copyFileSync,
  constants,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { defaultDesignPreferences } from "./design-rules.mjs";
import {
  id,
  revision,
  validatePlan,
  string,
  number,
  demoPlan,
  emptyPlan,
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
    // The image origin can be far outside a small, offset drawing on a large sheet.
    x: number(
      value.x,
      "原图 X",
      -100000 - value.imgW * value.mmPerPx,
      100000 + value.imgW * value.mmPerPx,
    ),
    y: number(
      value.y,
      "原图 Y",
      -100000 - value.imgH * value.mmPerPx,
      100000 + value.imgH * value.mmPerPx,
    ),
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
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2), {
      encoding: "utf8",
      flush: true,
    });
    renameSync(temp, file);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // Preserve the original write/rename error if the directory became inaccessible.
    }
    throw error;
  }
};
const projectIdPattern = /^[a-f0-9]{16}$/;
class ProjectFileError extends Error {
  constructor(file, reason) {
    super(
      `项目文件 ${file} ${reason}。请从备份恢复到 workspace/projects 后重试。`,
    );
    this.reason = reason;
    this.status = 422;
  }
}
function normalizeStoredProject(p, projectId, file) {
  if (
    p?.id !== projectId ||
    typeof p.name !== "string" ||
    (p.assumptions != null &&
      (!Array.isArray(p.assumptions) ||
        !p.assumptions.every((text) => typeof text === "string"))) ||
    !Array.isArray(p.variants) ||
    !p.variants.length
  )
    throw new ProjectFileError(file, "的项目或方案数据不完整");
  let canonical = true;
  const variantIds = new Set();
  for (const v of p.variants) {
    if (
      !v ||
      !projectIdPattern.test(v.id) ||
      variantIds.has(v.id) ||
      typeof v.name !== "string" ||
      (v.messages != null &&
        (!Array.isArray(v.messages) ||
          !v.messages.every(
            (message) =>
              message &&
              typeof message.role === "string" &&
              typeof message.content === "string",
          ))) ||
      (v.history != null && !Array.isArray(v.history))
    )
      throw new ProjectFileError(file, "的方案编号、名称或历史格式不正确");
    variantIds.add(v.id);
    const entries = [v, ...(v.history ?? [])];
    for (const [index, entry] of entries.entries()) {
      try {
        const previous = entry?.plan;
        const checked = validatePlan(previous),
          hash = revision(checked);
        if (entry.revision !== hash || revision(previous) !== hash)
          canonical = false;
        entry.plan = checked;
        entry.revision = hash;
      } catch (error) {
        const location = index === 0 ? "当前方案" : `历史版本 ${index}`;
        throw new ProjectFileError(
          file,
          `的「${v.name}」${location}无法加载，${error.message}`,
        );
      }
    }
  }
  return canonical;
}
function thumbnailGeometry(plan) {
  return {
    nodes: plan.nodes.map(({ id, x, y }) => ({ id, x, y })),
    walls: plan.walls.map(({ a, b, t, status, bearing }) => ({
      a,
      b,
      t,
      status,
      bearing,
    })),
    furniture: plan.furniture.map(({ x, y, w, d, rot, color }) => ({
      x,
      y,
      w,
      d,
      rot,
      color,
    })),
  };
}
function summarizeProject(p) {
  return {
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    variantCount: p.variants.length,
    variants: p.variants.map(({ id, name, description }) => ({
      id,
      name,
      description,
    })),
    hasImage: !!p.image,
    assumptions: [...(p.assumptions ?? [])],
    deletedAt: p.deletedAt,
    lifecycle: p.lifecycle ?? 0,
    ...(!p.deletedAt ? { preview: thumbnailGeometry(p.variants[0].plan) } : {}),
  };
}
export function createStore(directory, secretCodec) {
  const projectsDir = join(directory, "projects");
  mkdirSync(projectsDir, { recursive: true });
  const read = (file, fallback) => {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return fallback;
      throw error;
    }
  };
  const projectPath = (projectId) => {
    if (!projectIdPattern.test(projectId)) throw new Error("项目 ID 无效");
    return join(projectsDir, projectId + ".json");
  };
  // Cache only file identity and thumbnail metadata, never mutable plans, chat or history.
  const catalogIndex = new Map();
  function readProject(projectId, summaryOnly = false) {
    const path = projectPath(projectId),
      file = projectId + ".json";
    try {
      const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
      if (!stat) {
        catalogIndex.delete(projectId);
        return undefined;
      }
      const stamp = [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join("/");
      let known = catalogIndex.get(projectId);
      if (known?.stamp !== stamp) known = null;
      if (known && summaryOnly) return known.summary;
      const p = read(path);
      if (p === undefined) return undefined;
      // Reapply legacy defaults to each freshly decoded copy until a normal save persists them.
      if (!known?.canonical) {
        const canonical = normalizeStoredProject(p, projectId, file);
        if (!known) {
          known = { stamp, canonical, summary: summarizeProject(p) };
          catalogIndex.set(projectId, known);
        }
      }
      return summaryOnly ? known.summary : p;
    } catch (error) {
      if (error instanceof ProjectFileError) throw error;
      throw new ProjectFileError(
        file,
        error instanceof SyntaxError ? "不是完整的 JSON" : "暂时无法读取",
      );
    }
  }
  const settingsPath = join(directory, "settings.json");
  const initializedPath = join(directory, "workspace-initialized.json");
  let settingsWrites = Promise.resolve();
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
    let saved;
    try {
      saved = read(settingsPath);
      if (
        saved !== undefined &&
        (!saved || typeof saved !== "object" || Array.isArray(saved))
      )
        throw new SyntaxError("Invalid settings record");
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return {
        ...defaults,
        settingsError:
          "settings.json 已损坏。请重新填写模型配置并保存，原文件将备份到 workspace 下的 settings-unreadable-*.bak。",
      };
    }
    return {
      ...defaults,
      ...saved,
      ...(saved && !saved.provider ? { provider: "api" } : {}),
    };
  };
  function catalog(deleted = false, withPreviews = false) {
    const projects = [],
      unreadable = [];
    const files = new Set(readdirSync(projectsDir));
    for (const id of catalogIndex.keys())
      if (!files.has(id + ".json")) catalogIndex.delete(id);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const projectId = file.slice(0, -5);
      try {
        if (!projectIdPattern.test(projectId))
          throw new ProjectFileError(file, "的文件名与项目 ID 不符");
        const entry = readProject(projectId, true);
        if (!entry || !!entry.deletedAt !== deleted) continue;
        const { preview, ...summary } = entry;
        if (withPreviews && !deleted) summary.preview = preview;
        projects.push(structuredClone(summary));
      } catch (error) {
        if (!(error instanceof ProjectFileError)) throw error;
        unreadable.push({ file, reason: error.reason });
      }
    }
    projects.sort((a, b) => b.updatedAt - a.updatedAt);
    return { projects, unreadable };
  }
  const list = (deleted = false) => catalog(deleted).projects;
  const get = (projectId) => {
    const p = readProject(projectId);
    if (!p) {
      const e = new Error("项目不存在");
      e.status = 404;
      throw e;
    }
    if (p.deletedAt) {
      const e = new Error("项目已移入回收站，请先恢复项目");
      e.status = 410;
      throw e;
    }
    p.lifecycle ??= 0;
    p.underlayVersion ??= 0;
    p.assumptions ??= [];
    p.designPreferences = {
      ...defaultDesignPreferences,
      ...p.designPreferences,
    };
    for (const v of p.variants) {
      v.history ??= [];
      v.messages ??= [];
    }
    return p;
  };
  const save = (p) => {
    if (existsSync(projectPath(p.id))) {
      const existing = get(p.id);
      if (existing.lifecycle !== (p.lifecycle ?? 0))
        throw new Conflict("项目已经删除或恢复，请重新打开后操作");
    }
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
    catalog,
    get,
    save,
    assertLifecycle(projectId, lifecycle) {
      const p = get(projectId);
      if ((lifecycle ?? 0) !== p.lifecycle)
        throw new Conflict("项目已经删除或恢复，请重新打开后操作");
      return p;
    },
    trash(projectId, lifecycle) {
      const p = this.assertLifecycle(projectId, lifecycle);
      p.deletedAt = Date.now();
      p.lifecycle++;
      atomic(projectPath(projectId), p);
      return { id: p.id, name: p.name, deletedAt: p.deletedAt };
    },
    listTrash() {
      return list(true);
    },
    restore(projectId, lifecycle) {
      const p = readProject(projectId);
      if (!p?.deletedAt)
        throw new Conflict("该项目已恢复或不在回收站，请刷新列表");
      if (p.lifecycle !== lifecycle)
        throw new Conflict("回收站状态已变化，请刷新列表");
      delete p.deletedAt;
      p.lifecycle++;
      atomic(projectPath(projectId), p);
      return get(projectId);
    },
    setDesignPreferences(projectId, body) {
      const p = this.assertLifecycle(projectId, body.lifecycle);
      for (const key of Object.keys(defaultDesignPreferences)) {
        if (typeof body[key] !== "boolean") throw new Error("设计范围设置无效");
        p.designPreferences[key] = body[key];
      }
      save(p);
      return p.designPreferences;
    },
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
      if (s.settingsError) throw new Error(s.settingsError);
      let apiKey = "";
      if (s.provider === "api" && s.encryptedKey) {
        try {
          apiKey = await secretCodec.decrypt(s.encryptedKey);
        } catch {
          throw new Error("当前系统无法读取保存的密钥，请在模型设置中重新输入");
        }
      }
      return {
        ...s,
        runtimeDir: join(directory, "requests"),
        apiKey,
      };
    },
    setSettings(body) {
      const write = async () => {
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
          throw new Error(
            "API 地址必须是 HTTP(S)，不能包含账号、查询参数或片段",
          );
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
        if (prior.settingsError)
          copyFileSync(
            settingsPath,
            join(directory, `settings-unreadable-${id()}.bak`),
            constants.COPYFILE_EXCL,
          );
        atomic(settingsPath, next);
        return this.publicSettings();
      };
      const result = settingsWrites.then(write);
      settingsWrites = result.catch(() => {});
      return result;
    },
    create({
      name,
      variants,
      image = null,
      underlay = null,
      assumptions = [],
      imageImport,
    }) {
      if (!Array.isArray(variants) || !variants.length || variants.length > 12)
        throw new Error("项目需要 1–12 个方案");
      const p = {
        id: id(),
        name: string(name, "项目名称"),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lifecycle: 0,
        underlayVersion: 0,
        designPreferences: { ...defaultDesignPreferences },
        image,
        ...(imageImport ? { imageImport } : {}),
        underlay,
        assumptions: assumptions
          .filter((x) => typeof x === "string")
          .slice(0, 30),
        variants: variants.map(makeVariant),
      };
      return save(p);
    },
    createImageDraft(image, options) {
      const name = options.name || "户型底图";
      const plan = emptyPlan("原图描墙", options.height);
      plan.phase = "original";
      return this.create({
        name,
        image,
        variants: [{ name: plan.name, plan }],
        underlay: validateUnderlay({
          src: image.dataUrl,
          imgW: image.width,
          imgH: image.height,
          mmPerPx: Math.min(
            10000,
            ((options.widthMeters ?? 10) * 1000) / image.width,
          ),
          x: 0,
          y: 0,
          visible: true,
          locked: true,
          opacity: 0.5,
        }),
        assumptions: [
          "原图已保存。底图比例为暂估，可在图上选取一段已知长度校准。",
        ],
        imageImport: { options, edited: false },
      });
    },
    finishImageDraft(source, result, reason) {
      const p = this.assertLifecycle(source.id, source.lifecycle);
      if (
        !!p.imageImport !== !!source.imageImport ||
        p.imageImport?.edited ||
        p.variants.length !== source.variants.length ||
        p.variants.some(
          (v, i) =>
            v.id !== source.variants[i].id ||
            v.revision !== source.variants[i].revision ||
            v.history.length !== source.variants[i].history.length ||
            v.messages.length !== source.variants[i].messages.length,
        ) ||
        p.underlayVersion !== source.underlayVersion
      )
        throw new Conflict(
          "底图已有新的编辑，已保留当前进度。可用原图另建识别项目。",
        );
      if (!result) {
        p.imageImport.reason = reason;
      } else {
        p.name = string(result.name, "项目名称");
        p.variants = result.variants.map(makeVariant);
        p.variants.forEach((v, i) => {
          if (source.variants[i]) v.id = source.variants[i].id;
        });
        p.underlay = validateUnderlay(result.underlay);
        p.underlayVersion++;
        p.assumptions = result.assumptions.slice(0, 30);
        delete p.imageImport;
      }
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
      expectedUnderlayVersion,
    ) {
      const { p, v } = this.variant(projectId, variantId);
      if (v.revision !== expected) throw new Conflict();
      const valid = validatePlan(plan),
        hash = revision(valid);
      if (underlay !== undefined) {
        const calibrated = validateUnderlay(underlay);
        if (JSON.stringify(calibrated) !== JSON.stringify(p.underlay)) {
          if (
            expectedUnderlayVersion !== undefined &&
            expectedUnderlayVersion !== p.underlayVersion
          )
            throw new Conflict("底图已在其他方案中修改，请重新打开项目后校准");
          const calibrationChanged = ["src", "x", "y", "mmPerPx"].some(
            (key) => calibrated?.[key] !== p.underlay?.[key],
          );
          p.underlay = calibrated;
          p.underlayVersion++;
          if (p.imageImport && calibrationChanged) p.imageImport.edited = true;
        }
      }
      if (hash === v.revision) {
        if (underlay !== undefined) save(p);
        return {
          revision: v.revision,
          plan: v.plan,
          underlay: p.underlay,
          underlayVersion: p.underlayVersion,
          ...(p.imageImport ? { imageImport: p.imageImport } : {}),
        };
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
      if (p.imageImport) p.imageImport.edited = true;
      save(p);
      return {
        revision: hash,
        plan: valid,
        underlay: p.underlay,
        underlayVersion: p.underlayVersion,
        ...(p.imageImport ? { imageImport: p.imageImport } : {}),
      };
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
      if (existsSync(initializedPath)) return;
      if (readdirSync(projectsDir).some((name) => name.endsWith(".json"))) {
        atomic(initializedPath, { initialized: true });
        return;
      }
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
          atomic(initializedPath, { initialized: true });
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
      atomic(initializedPath, { initialized: true });
    },
  };
}
