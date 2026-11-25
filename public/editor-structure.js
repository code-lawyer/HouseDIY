(() => {
  const classify = window.__wallStructure;
  const labels = {
    bearing: "承重墙",
    unknown: "承重待核实",
    partition: "非承重墙",
  };
  window.__wallStructureLabel = (wall) =>
    wall.bearing === true && wall.bearingFrom === "inferred"
      ? "疑似承重，待核实"
      : labels[classify(wall)];

  document.addEventListener("DOMContentLoaded", () => {
    const inspector = document.getElementById("inspector");
    if (!inspector) return;
    new MutationObserver(() => {
      const checkbox = inspector.querySelector("#wBear"),
        editor = window.__designer;
      if (!checkbox || editor?.app.sel.kind !== "wall") return;
      const wall = editor.app.plan.walls.find(
        (w) => w.id === editor.app.sel.id,
      );
      if (!wall) return;
      const select = document.createElement("select");
      select.setAttribute("aria-label", "结构图标注的承重属性");
      for (const [value, label] of [
        ["unknown", "承重待核实"],
        ["bearing", "承重墙"],
        ["partition", "已核实非承重墙"],
      ])
        select.add(new Option(label, value));
      select.value =
        wall.bearingFrom === "inferred" && wall.status !== "new"
          ? "unknown"
          : classify(wall);
      select.onchange = () => {
        wall.bearing =
          select.value === "unknown" ? null : select.value === "bearing";
        wall.bearingFrom = select.value === "unknown" ? "inferred" : "drawing";
        editor.commit();
      };
      checkbox.parentElement.replaceChildren("结构图标注", select);
    }).observe(inspector, { childList: true, subtree: true });
  });
})();
