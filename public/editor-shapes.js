(() => {
  let library = { revision: 0, items: [] };
  const endpoint = "/api/shapes";
  async function refresh() {
    const response = await fetch(endpoint);
    if (!response.ok) return false;
    library = await response.json();
    return true;
  }
  window.houseShapes = {
    ready: refresh().catch(() => false),
    items: () => structuredClone(library.items),
    async save(items) {
      try {
        if (!(await this.ready)) return false;
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revision: library.revision, items }),
        });
        if (response.status === 409) await refresh();
        if (!response.ok) return false;
        library = await response.json();
        return true;
      } catch {
        return false;
      }
    },
  };
})();
