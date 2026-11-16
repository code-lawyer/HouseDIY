import { operationSchema } from "./operations.mjs";
const str = { type: "string" },
  num = { type: "number" },
  bool = { type: "boolean" },
  arr = (items) => ({ type: "array", items }),
  point = { type: "array", items: num, minItems: 2, maxItems: 2 };
const object = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
export const chatSchema = object({
  reply: str,
  operations: arr(operationSchema({ strict: true })),
});
export const recognitionSchema = object({
  name: str,
  scale: object({
    mmPerPixel: num,
    source: { type: "string", enum: ["dimension", "estimate"] },
    reason: str,
  }),
  walls: arr(object({ a: point, b: point, thickness: num, bearing: bool })),
  openings: arr(
    object({
      wall: { type: "integer" },
      center: point,
      type: str,
      width: num,
      sill: num,
      head: num,
    }),
  ),
  rooms: arr(object({ name: str, at: point, mat: str })),
  assumptions: arr(str),
  schemes: arr(
    object({
      name: str,
      description: str,
      furniture: arr(
        object({
          key: str,
          at: point,
          rot: num,
          w: num,
          d: num,
          h: num,
          color: str,
        }),
      ),
    }),
  ),
});
export const testSchema = object({ reply: str });
