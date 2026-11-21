// Desktop persistence for the pinned designer's model catalog. Offline HTML exports
// use the designer's built-in model records and have no desktop service.
if (location.protocol === "http:" && window.parent !== window) {
  const missing = new Set();
  const warnings = [];
  const path = (id) => "/api/models/" + encodeURIComponent(id);
  async function request(url, options) {
    const res = await fetch(url, options);
    const value = await res.json();
    if (!res.ok) {
      const error = new Error(value.error || "无法访问本地模型库");
      error.status = res.status;
      throw error;
    }
    return value;
  }
  async function put(record, { repair = false } = {}) {
    const { data, ...meta } = record;
    if (data.byteLength > 64_000_000)
      throw new Error("单个 GLB 模型上限为 64 MB");
    const b64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(",")[1]);
      reader.onerror = () => reject(new Error("读取模型文件失败"));
      reader.readAsDataURL(new Blob([data]));
    });
    await request(path(meta.id), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...meta,
        b64,
        repair: repair && missing.has(meta.id),
      }),
    });
    missing.delete(meta.id);
  }
  async function load(readLegacy) {
    const records = [];
    const furniture = window.__PRESET__.plan.furniture;
    const required = new Set(
      furniture
        .map(
          (f) => f.modelId || (f.key?.startsWith("model:") && f.key.slice(6)),
        )
        .filter(Boolean),
    );
    const ids = new Set(required);
    try {
      for (const id of await request("/api/models")) ids.add(id);
      for (const record of await readLegacy().catch(() => [])) {
        const marker = "housediy-migrated-model-" + record.id;
        if (localStorage.getItem(marker)) continue;
        await put(record);
        localStorage.setItem(marker, "1");
        ids.add(record.id);
      }
    } catch (error) {
      warnings.push(error.message);
    }
    for (const id of ids) {
      try {
        const { b64, ...meta } = await request(path(id));
        const data = Uint8Array.fromBase64(b64).buffer;
        records.push({ ...meta, data });
      } catch (error) {
        if (required.has(id) && [404, 422].includes(error.status))
          missing.add(id);
        if (error.status !== 404 || !required.has(id))
          warnings.push("读取模型 " + id + " 失败：" + error.message);
      }
    }
    return records;
  }
  window.houseModels = {
    load,
    put,
    missing,
    warnings,
    remove: (id) => request(path(id), { method: "DELETE" }),
  };
}
