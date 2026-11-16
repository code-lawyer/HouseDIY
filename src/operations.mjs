// One operation contract for Codex, compatible APIs and the local executor.
const str = { type: "string" };
const num = { type: "number" };
const point = { type: "array", items: num, minItems: 2, maxItems: 2 };
export const openingTypes = [
  "door",
  "double",
  "unequal",
  "sliding",
  "folding",
  "pocket",
  "hole",
  "window",
  "slideWindow",
  "floorWindow",
  "highWindow",
  "bay",
  "garage",
  "glassWall",
];
const opening = {
  type: { type: "string", enum: openingTypes },
  pos: num,
  width: num,
  sill: num,
  head: num,
  hinge: { type: "number", enum: [0, 1] },
  side: { type: "number", enum: [-1, 1] },
};
const furniture = {
  ...Object.fromEntries(
    ["x", "y", "w", "d", "h", "rot", "z"].map((k) => [k, num]),
  ),
  color: str,
  name: str,
};
const define = (properties, required) => ({ properties, required });
export const operationDefinitions = {
  add_furniture: define({ key: str, ...furniture }, ["key", "x", "y"]),
  update_furniture: define({ id: str, ...furniture }, ["id"]),
  remove_furniture: define({ id: str }, ["id"]),
  update_room: define({ id: str, name: str, mat: str, wallMat: str }, ["id"]),
  add_wall: define({ a: point, b: point, t: num }, ["a", "b"]),
  update_wall: define({ id: str, a: point, b: point, t: num }, ["id"]),
  remove_wall: define({ id: str }, ["id"]),
  add_opening: define({ wallId: str, ...opening }, ["wallId", "pos"]),
  update_opening: define({ id: str, ...opening }, ["id"]),
  remove_opening: define({ id: str }, ["id"]),
};

export function operationSchema({ strict = false } = {}) {
  return {
    anyOf: Object.entries(operationDefinitions).map(
      ([op, { properties, required }]) => ({
        type: "object",
        properties: {
          op: { type: "string", enum: [op] },
          ...Object.fromEntries(
            Object.entries(properties).map(([key, schema]) => [
              key,
              strict && !required.includes(key)
                ? { anyOf: [schema, { type: "null" }] }
                : schema,
            ]),
          ),
        },
        required: ["op", ...(strict ? Object.keys(properties) : required)],
        additionalProperties: false,
      }),
    ),
  };
}

export function parseOperation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("修改操作格式错误");
  const definition = Object.hasOwn(operationDefinitions, value.op)
    ? operationDefinitions[value.op]
    : null;
  if (!definition) throw new Error(`不支持的操作 ${value.op}`);
  const result = { op: value.op };
  for (const [key, field] of Object.entries(value)) {
    if (key === "op") continue;
    if (!Object.hasOwn(definition.properties, key))
      throw new Error(`${value.op} 不支持字段 ${key}`);
    if (field == null && !definition.required.includes(key)) continue;
    const schema = definition.properties[key];
    const valid =
      schema.type === "array"
        ? Array.isArray(field) &&
          field.length === 2 &&
          field.every(Number.isFinite)
        : typeof field === schema.type &&
          (schema.type !== "number" || Number.isFinite(field));
    if (!valid || (schema.enum && !schema.enum.includes(field)))
      throw new Error(`${value.op} 的 ${key} 格式或取值无效`);
    result[key] = field;
  }
  for (const key of definition.required)
    if (result[key] === undefined) throw new Error(`${value.op} 缺少 ${key}`);
  return result;
}
