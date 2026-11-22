import { createServer } from "node:http";
import { once } from "node:events";
export const recognition = {
  name: "验收户型",
  scale: { mmPerPixel: 10, source: "dimension", reason: "标注 5.6 米" },
  walls: [
    { a: [20, 20], b: [580, 20], thickness: 200, bearing: true },
    { a: [580, 20], b: [580, 430], thickness: 200, bearing: true },
    { a: [580, 430], b: [20, 430], thickness: 200, bearing: true },
    { a: [20, 430], b: [20, 20], thickness: 200, bearing: true },
  ],
  openings: [
    {
      wall: 0,
      center: [300, 20],
      width: 1800,
      type: "window",
      sill: 900,
      head: 2200,
    },
  ],
  rooms: [{ name: "客厅", at: [300, 200], mat: "oak" }],
  assumptions: ["用于验证流程的测试户型"],
  schemes: ["浅木", "暖灰", "阅读"].map((name, i) => ({
    name,
    description: "测试方案 " + i,
    furniture: [
      {
        key: "sofa",
        at: [420, 220 + 15 * i],
        rot: 90,
        w: 2200,
        d: 950,
        h: 820,
        color: ["#ccbbaa", "#999999", "#bb8877"][i],
      },
    ],
  })),
};
export async function mockProvider() {
  let delay = 0;
  let nextHeldResponse = null;
  const scriptedOperations = [],
    scriptedRecognition = [];
  const requests = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const b of req) text += b;
    const data = JSON.parse(text);
    requests.push(data);
    const held = nextHeldResponse;
    nextHeldResponse = null;
    if (held) {
      held.received();
      await held.wait;
    }
    try {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (data.model === "unauthorized") {
        res.writeHead(401).end("do not expose test-secret");
        return;
      }
      let content = "OK",
        calls;
      if (!data.stream)
        content = JSON.stringify(scriptedRecognition.shift() ?? recognition);
      else if (data.tools) {
        const message = String(
            data.messages.findLast((m) => m.role === "user").content,
          ),
          scene = JSON.parse(data.messages[0].content.split("当前场景：")[1]);
        let operations;
        if (message.includes("拆除"))
          operations = [{ op: "remove_wall", id: scene.selection?.id }];
        else if (message.includes("隔墙"))
          operations = [
            { op: "add_wall", a: [200, 2000], b: [2000, 2000], t: 100 },
          ];
        else if (message.includes("添加"))
          operations = [
            { op: "add_furniture", key: "plant", x: 5300, y: 3600 },
          ];
        else
          operations = [
            {
              op: "update_furniture",
              id: scene.selection?.id || scene.furniture[0].id,
              color: "#d4c5af",
            },
          ];
        if (scriptedOperations.length) operations = scriptedOperations.shift();
        calls = [
          {
            index: 0,
            id: "change1",
            type: "function",
            function: {
              name: "propose_changes",
              arguments: JSON.stringify({
                explanation: "已准备好这组修改。",
                operations,
              }),
            },
          },
        ];
        content = "";
      }
      if (data.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          "data: " +
            JSON.stringify({
              choices: [{ delta: { content, tool_calls: calls } }],
            }) +
            "\n\n",
        );
        res.end("data: [DONE]\n\n");
      } else {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            choices: [
              {
                message: { role: "assistant", content },
                finish_reason: "stop",
              },
            ],
          }),
        );
      }
    } finally {
      held?.completed();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: "http://127.0.0.1:" + server.address().port + "/v1",
    requests,
    enqueueOperations: (...responses) => scriptedOperations.push(...responses),
    enqueueRecognition: (...responses) =>
      scriptedRecognition.push(...responses),
    setDelay: (ms) => (delay = ms),
    holdNextResponse: () => {
      if (nextHeldResponse) throw new Error("A response is already held");
      const received = Promise.withResolvers();
      const released = Promise.withResolvers();
      const completed = Promise.withResolvers();
      nextHeldResponse = {
        received: received.resolve,
        wait: released.promise,
        completed: completed.resolve,
      };
      return {
        received: received.promise,
        release: released.resolve,
        completed: completed.promise,
      };
    },
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  };
}
