import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomic, Conflict } from "./store.mjs";

export function createShapeLibrary(directory) {
  const file = join(directory, "shapes.json");
  const read = () => {
    try {
      const value = JSON.parse(readFileSync(file, "utf8"));
      if (!Number.isSafeInteger(value?.revision) || !Array.isArray(value.items))
        throw new Error("Invalid shape library");
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return { revision: 0, items: [] };
      throw new Error("「我的造型」库无法读取。请检查 workspace/shapes.json。");
    }
  };
  return {
    read,
    replace({ revision, items }) {
      const current = read();
      if (revision !== current.revision)
        throw new Conflict("造型库已有新内容，已刷新，请重试");
      if (!Array.isArray(items) || items.length > 500)
        throw new Error("造型库数据无效或已达容量上限");
      const ids = new Set();
      for (const item of items) {
        if (
          !/^[a-z0-9_-]{1,100}$/i.test(item?.id ?? "") ||
          ids.has(item.id) ||
          typeof item.name !== "string" ||
          item.name.length > 200 ||
          typeof item.model !== "string" ||
          ![item.w, item.h, item.d].every(
            (size) => Number.isFinite(size) && size >= 0,
          )
        )
          throw new Error("造型库包含无效条目");
        try {
          if (!Array.isArray(JSON.parse(item.model)?.parts)) throw new Error();
        } catch {
          throw new Error("造型缺少可编辑的部件");
        }
        ids.add(item.id);
      }
      const next = { revision: current.revision + 1, items };
      atomic(file, next);
      return next;
    },
  };
}
