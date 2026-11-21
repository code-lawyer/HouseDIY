export const openingLabels = {
  door: "单扇门",
  double: "双开门",
  unequal: "子母门",
  sliding: "推拉门",
  folding: "折叠门",
  pocket: "移入墙门",
  hole: "垭口",
  window: "平窗",
  slideWindow: "推拉窗",
  floorWindow: "落地窗",
  highWindow: "高窗",
  bay: "飘窗",
  garage: "车库门",
  glassWall: "玻璃隔断",
};
export const openingTypes = Object.keys(openingLabels);
const within = (value, min, max) =>
  Number.isFinite(value) && value >= min && value <= max;

export function validateOpening(o, length, height) {
  if (!Number.isFinite(length) || !openingTypes.includes(o.type))
    throw new Error("门窗的所属墙或类型无效");
  if (!within(o.pos, 0, length)) throw new Error("门窗位置超出所属墙段");
  if (!within(o.width, 100, 20000)) throw new Error("门窗宽度超出允许范围");
  const sill = o.sill ?? 0,
    head = o.head ?? 2100;
  if (!within(sill, 0, height) || !within(head, 100, height) || head <= sill)
    throw new Error("门窗顶高必须高于窗台并在层高以内");
  if (o.pos - o.width / 2 < -20 || o.pos + o.width / 2 > length + 20)
    throw new Error("门窗超出所属墙段，请先调整墙段或门窗宽度");
}

export function projectAlongWall(a, b, x, y) {
  return (
    ((x - a.x) * (b.x - a.x) + (y - a.y) * (b.y - a.y)) /
    Math.hypot(b.x - a.x, b.y - a.y)
  );
}
