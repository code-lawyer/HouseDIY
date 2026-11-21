import {
  openingLabels,
  validateOpening,
  projectAlongWall,
} from "/opening-placement.js";

export function openingRecovery(D, post) {
  const pane = document.getElementById("pane2d");
  const layer = document.createElement("div");
  layer.className = "opening-markers";
  layer.dataset.housediyDesktop = "";
  pane.append(layer);
  const canvas = document.getElementById("c2d");
  let lastList = "",
    pixels = new Map(),
    frame = 0,
    lastTransform = "";
  const pending = () => D.app.plan.pendingOpenings ?? [];
  const get = (id) => {
    const item = pending().find((o) => o.id === id);
    if (!item) throw new Error("这处门窗已处理，请查看当前方案。");
    return item;
  };
  function update() {
    const list = pending();
    const signature = JSON.stringify(list);
    if (signature !== lastList) {
      lastList = signature;
      pixels = new Map(list.filter((o) => o.pixel).map((o) => [o.id, o.pixel]));
      lastTransform = "";
      layer.replaceChildren();
      for (const o of list.filter((o) => o.pixel)) {
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.openingId = o.id;
        b.textContent = String(o.ordinal);
        b.title = b.ariaLabel = `指定原图门窗 ${o.ordinal} 的所属墙`;
        b.onclick = () => post({ type: "repair-marker", id: o.id });
        layer.append(b);
      }
      post({ type: "pending-openings", items: list });
    }
    if (!frame) positionMarkers();
  }
  function positionMarkers() {
    frame = 0;
    const u = D.app.underlay;
    layer.hidden = !u || !pixels.size || D.app.view === "3d";
    if (layer.hidden) return;
    frame = requestAnimationFrame(positionMarkers);
    const { ox, oy, s, W, H } = D.view;
    const scaleX = canvas.clientWidth / (W || canvas.clientWidth),
      scaleY = canvas.clientHeight / (H || canvas.clientHeight);
    const transform = [
      ox,
      oy,
      s,
      scaleX,
      scaleY,
      u.x,
      u.y,
      u.mmPerPx,
      canvas.offsetLeft,
      canvas.offsetTop,
    ].join("/");
    if (transform === lastTransform) return;
    lastTransform = transform;
    for (const button of layer.children) {
      const [x, y] = pixels.get(button.dataset.openingId);
      button.style.left =
        canvas.offsetLeft + (ox + (u.x + x * u.mmPerPx) * s) * scaleX + "px";
      button.style.top =
        canvas.offsetTop + (oy + (u.y + y * u.mmPerPx) * s) * scaleY + "px";
    }
  }
  function walls() {
    const nodes = new Map(D.app.plan.nodes.map((n) => [n.id, n]));
    return D.app.plan.walls
      .filter((w) => !["removed", "demolish"].includes(w.status))
      .map((w) => ({ id: w.id, a: nodes.get(w.a), b: nodes.get(w.b) }));
  }
  function choices(id) {
    const o = get(id),
      u = D.app.underlay;
    return {
      item: o,
      labels: openingLabels,
      walls: walls().map(({ id, a, b }, i) => {
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        const pos =
          u && o.pixel
            ? projectAlongWall(
                a,
                b,
                u.x + o.pixel[0] * u.mmPerPx,
                u.y + o.pixel[1] * u.mmPerPx,
              )
            : length / 2;
        return {
          id,
          label: `墙 ${i + 1} · ${Math.round(length)} mm`,
          pos: Math.round(Math.max(0, Math.min(length, pos))),
        };
      }),
    };
  }
  function attach(input) {
    const old = get(input.id),
      w = walls().find((w) => w.id === input.wall);
    if (!w) throw new Error("请选择图中仍然存在的墙。");
    const o = {
      id: old.id,
      wall: w.id,
      type: input.type,
      pos: input.pos,
      width: input.width,
      sill: input.sill,
      head: input.head,
      hinge: old.hinge,
      side: old.side,
    };
    validateOpening(
      o,
      Math.hypot(w.a.x - w.b.x, w.a.y - w.b.y),
      D.app.plan.height,
    );
    const plan = D.app.plan;
    plan.openings.push(o);
    plan.pendingOpenings = pending().filter((item) => item.id !== o.id);
    D.commit();
    D.select("opening", o.id);
    D.requestDraw();
    if (D.S3.ready) D.S3.renderNow();
    update();
  }
  return { update, choices, attach };
}
