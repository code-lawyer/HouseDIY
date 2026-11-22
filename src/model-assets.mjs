import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

export const maxPlanFileBytes = 96_000_000;
const maxModelBytes = 64_000_000;
const validId = (id) => typeof id === "string" && /^[a-z0-9_-]{1,80}$/.test(id);
const base64 = /^[A-Za-z0-9+/]+={0,2}$/;
const invalid = () => new Error("自定义模型数据无效，请重新选择原始 GLB 文件");
const modelError = (status, message) =>
  Object.assign(new Error(message), { status });
const writes = new Map();

function checkRecord(input) {
  if (
    !input ||
    !validId(input.id) ||
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.length > 240
  )
    throw invalid();
  const { id, name, w, d, h, b64 } = input;
  if (
    [w, d, h].some((n) => !Number.isFinite(n) || n < 0) ||
    typeof b64 !== "string" ||
    b64.length > Math.ceil(maxModelBytes / 3) * 4 ||
    b64.length % 4 ||
    !base64.test(b64)
  )
    throw invalid();
  const raw = Buffer.from(b64, "base64");
  if (
    raw.length < 20 ||
    raw.length > maxModelBytes ||
    raw.toString("ascii", 0, 4) !== "glTF" ||
    raw.readUInt32LE(4) !== 2 ||
    raw.readUInt32LE(8) !== raw.length ||
    raw.toString("ascii", 16, 20) !== "JSON" ||
    raw.readUInt32LE(12) > raw.length - 20
  )
    throw invalid();
  let document;
  try {
    document = JSON.parse(raw.toString("utf8", 20, 20 + raw.readUInt32LE(12)));
  } catch {
    throw invalid();
  }
  if (document?.asset?.version !== "2.0") throw invalid();
  const sha256 = createHash("sha256").update(raw).digest("hex");
  if (input.sha256 !== undefined && input.sha256 !== sha256) throw invalid();
  const record = { id, name, w, d, h, size: raw.length, sha256, b64 };
  for (const key of ["icon", "top"]) {
    const value = input[key];
    if (value == null || value === "") continue;
    if (
      typeof value !== "string" ||
      value.length > 2_000_000 ||
      !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/u.test(value)
    )
      throw invalid();
    record[key] = value;
  }
  return record;
}

function referencedIds(plan) {
  return [
    ...new Set(
      plan.furniture
        .map(
          (f) => f.modelId || (f.key?.startsWith("model:") && f.key.slice(6)),
        )
        .filter(Boolean),
    ),
  ];
}
export function projectModelIds(project) {
  if (!Array.isArray(project.variants) || !project.variants.length) return null;
  const ids = new Set();
  for (const variant of project.variants) {
    if (!variant || !Array.isArray(variant.history ?? [])) return null;
    for (const entry of [variant, ...(variant.history ?? [])]) {
      const plan = entry?.plan;
      if (plan?.version !== 2 || !Array.isArray(plan.furniture)) return null;
      for (const furniture of plan.furniture) {
        if (typeof furniture?.key !== "string") return null;
        const keyId = furniture.key.startsWith("model:")
          ? furniture.key.slice(6)
          : null;
        for (const id of [
          furniture.modelId === "" ? null : furniture.modelId,
          keyId,
        ]) {
          if (id == null) continue;
          if (!validId(id)) return null;
          ids.add(id);
        }
      }
    }
  }
  return ids;
}
export function createModelLibrary(workspace) {
  const directory = resolve(workspace, "models"),
    shelf = join(directory, "library"),
    cleanup = join(directory, "pending-cleanup.json");
  function pendingCleanup() {
    try {
      const queue = JSON.parse(readFileSync(cleanup, "utf8"));
      if (!Array.isArray(queue) || !queue.every(validId)) throw invalid();
      return queue;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return [];
    }
  }
  function saveCleanup(ids) {
    mkdirSync(directory, { recursive: true });
    const temp = join(directory, randomUUID() + ".tmp");
    try {
      writeFileSync(temp, JSON.stringify([...ids]), {
        flag: "wx",
        flush: true,
      });
      renameSync(temp, cleanup);
    } finally {
      try {
        unlinkSync(temp);
      } catch {
        /* The normal rename removes this path. */
      }
    }
  }
  const pathFor = (root, id) => {
    if (!validId(id)) throw invalid();
    return join(root, "model-" + id + ".json");
  };
  async function expectedHash(id) {
    let value;
    try {
      value = (
        await readFile(pathFor(directory, id) + ".sha256", "ascii")
      ).trim();
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw modelError(
        503,
        `无法读取模型 ${id} 的校验记录，请检查 workspace/models 的访问权限。`,
      );
    }
    if (!/^[a-f0-9]{64}$/.test(value))
      throw modelError(
        503,
        `模型校验记录 model-${id}.json.sha256 不完整，请从备份恢复后重试。`,
      );
    return value;
  }
  async function bindHash(record) {
    const path = pathFor(directory, record.id) + ".sha256";
    try {
      await writeFile(path, record.sha256 + "\n", { flag: "wx", flush: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if ((await expectedHash(record.id)) !== record.sha256)
        throw modelError(
          409,
          "所选 GLB 与该模型的原始校验值不同，请选择原文件。",
        );
    }
  }
  async function read(id) {
    const file = pathFor(directory, id);
    let raw;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT")
        throw modelError(
          404,
          "找不到自定义模型 " + id + "，请在编辑器中补回原 GLB 文件",
        );
      throw modelError(
        503,
        `无法读取 workspace/models/model-${id}.json，请检查文件访问权限。`,
      );
    }
    const expected = await expectedHash(id);
    let record;
    try {
      record = checkRecord(JSON.parse(raw));
      if (record.id !== id || (expected && expected !== record.sha256))
        throw invalid();
    } catch {
      throw modelError(
        422,
        `模型文件 model-${id}.json 已损坏。请在编辑器中选择原始 GLB 补回，损坏原件会保存在 workspace/models 的 .bak 文件中。`,
      );
    }
    if (!expected) {
      try {
        await bindHash(record);
      } catch (error) {
        if (error.status) throw error;
        // Read-only legacy workspaces can still display their previously valid files.
      }
    }
    return record;
  }
  async function writeRecord(record, repair) {
    const file = pathFor(directory, record.id);
    await mkdir(directory, { recursive: true });
    let damaged = false;
    try {
      const existing = await read(record.id);
      if (existing.sha256 !== record.sha256)
        throw modelError(409, "模型编号与已有文件冲突，已保留原模型。");
      await bindHash(record);
      return;
    } catch (error) {
      if (error.status === 422 && repair) damaged = true;
      else if (error.status !== 404) throw error;
    }
    // Reserve the byte identity before publishing a record. A retry after an
    // interrupted save, including a missing file, must supply the original bytes.
    await bindHash(record);
    const temp = join(directory, randomUUID() + ".tmp");
    try {
      await writeFile(temp, JSON.stringify(record), {
        flag: "wx",
        flush: true,
      });
      if (damaged)
        await copyFile(
          file,
          join(directory, `model-${record.id}-damaged-${randomUUID()}.bak`),
          constants.COPYFILE_EXCL,
        );
      await rename(temp, file);
    } finally {
      await unlink(temp).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  async function persist(record, repair = false) {
    const file = pathFor(directory, record.id);
    const previous = writes.get(file) ?? Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(() => writeRecord(record, repair));
    writes.set(file, task);
    try {
      await task;
    } catch (error) {
      if (error.status) throw error;
      throw modelError(
        503,
        "无法保存自定义模型，请检查 workspace/models 的可用空间和写入权限后重试。",
      );
    } finally {
      if (writes.get(file) === task) writes.delete(file);
    }
  }
  return {
    read,
    async list() {
      await mkdir(shelf, { recursive: true });
      return (await readdir(shelf))
        .map((name) => /^model-([a-z0-9_-]{1,80})\.json$/.exec(name)?.[1])
        .filter(Boolean);
    },
    async put(id, input, { repair = false } = {}) {
      const record = checkRecord(input);
      if (id !== record.id) throw invalid();
      await persist(record, repair === true);
      await mkdir(shelf, { recursive: true });
      await writeFile(pathFor(shelf, id), "");
    },
    async remove(id) {
      // The catalog entry can disappear while projects, trash and history retain their bytes.
      await unlink(pathFor(shelf, id)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
    pruneUnreferenced(candidates, references) {
      const queued = new Set([...pendingCleanup(), ...candidates]);
      if (!queued.size) return 0;
      if (candidates.size) saveCleanup(queued);
      const referenced = references();
      if (!referenced) return queued.size;
      const deferred = new Set();
      for (const id of queued) {
        const file = pathFor(directory, id);
        if (referenced.has(id)) continue;
        if (writes.has(file)) {
          deferred.add(id);
          continue;
        }
        try {
          if (lstatSync(pathFor(shelf, id), { throwIfNoEntry: false }))
            continue;
          const stat = lstatSync(file, { throwIfNoEntry: false });
          if (!stat) continue;
          if (
            !stat.isFile() ||
            JSON.parse(readFileSync(file, "utf8"))?.id !== id
          ) {
            deferred.add(id);
            continue;
          }
          unlinkSync(file);
        } catch {
          // Retry when we can verify the record or the OS releases its lock.
          deferred.add(id);
        }
      }
      if (deferred.size !== queued.size) saveCleanup(deferred);
      return deferred.size;
    },
    async forExport(plan) {
      const ids = referencedIds(plan);
      if (!ids.length) return plan;
      const models = [];
      let size = Buffer.byteLength(JSON.stringify(plan)) + 1000;
      for (const id of ids) {
        const record = await read(id);
        size += Buffer.byteLength(JSON.stringify(record)) + 1;
        if (size > maxPlanFileBytes - 4096)
          throw new Error("含模型的方案超过 96 MB，请备份整个 workspace 目录");
        models.push(record);
      }
      return { plan, models };
    },
    async importFor(plan, models) {
      if (models === undefined) return;
      if (!Array.isArray(models)) throw invalid();
      const ids = new Set(referencedIds(plan));
      const records = models.map(checkRecord);
      for (const record of records) if (!ids.delete(record.id)) throw invalid();
      if (ids.size) throw new Error("方案附件缺少自定义模型文件");
      // Unlisted bytes do not publish a project or change the library if a later write fails.
      for (const record of records) await persist(record);
    },
  };
}
