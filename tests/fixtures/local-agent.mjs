import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const imageFixture = { mimeType: "image/png", data: "AA==" };
const response = (image) => ({
  reply: image ? "fixture image" : "fixture text",
  operations: [],
});
const output = (value) => process.stdout.write(JSON.stringify(value) + "\n");
if (args[0] === "--version") {
  console.log("fixture-cli 3.1.2");
} else if (args.join(" ") === "auth status") {
  output({ loggedIn: true, email: "private-test@example.test" });
} else if (args.join(" ") === "login status") {
  console.log("Logged in");
} else if (args.includes("--acp")) {
  assert.match(
    readFileSync(args[args.indexOf("--admin-policy") + 1], "utf8"),
    /decision = "deny"/,
  );
  const reader = createInterface({ input: process.stdin });
  let reply;
  for await (const line of reader) {
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      assert.deepEqual(request.params.clientCapabilities, {});
      output({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: 1,
          agentCapabilities: { promptCapabilities: { image: true } },
        },
      });
    } else if (request.method === "session/new") {
      assert.deepEqual(request.params.mcpServers, []);
      output({
        jsonrpc: "2.0",
        id: 2,
        result: { sessionId: "fixture-session" },
      });
    } else if (request.method === "session/prompt") {
      const body = request.params.prompt,
        image = body.find((p) => p.type === "image");
      assert.equal(body[0].type, "text");
      if (image) assert.deepEqual(image, { ...imageFixture, type: "image" });
      reply = JSON.stringify(response(image));
      output({
        jsonrpc: "2.0",
        id: 8,
        method: "session/request_permission",
        params: {},
      });
    } else {
      assert.deepEqual(request.result, { outcome: { outcome: "cancelled" } });
      output({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fixture-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: reply },
          },
        },
      });
      output({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } });
    }
  }
} else {
  let input = "";
  for await (const chunk of process.stdin.setEncoding("utf8")) input += chunk;
  if (args[0] === "exec") {
    assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
    assert.equal(input, "synthetic plan");
    const image = args.includes("--image");
    if (image)
      assert.deepEqual(
        readFileSync(args[args.indexOf("--image") + 1]),
        Buffer.from([0]),
      );
    writeFileSync(
      args[args.indexOf("--output-last-message") + 1],
      JSON.stringify(response(image)),
    );
  } else {
    assert.ok(args.includes("--print"));
    assert.ok(args.includes("--safe-mode"));
    assert.equal(args[args.indexOf("--tools") + 1], "");
    assert.equal(args[args.indexOf("--setting-sources") + 1], "");
    assert.ok(args.includes("--no-session-persistence"));
    const {
      message: { content },
    } = JSON.parse(input);
    assert.equal(content[0].type, "text");
    assert.ok(content[0].text.startsWith("synthetic plan"));
    assert.ok(content[0].text.includes('"operations"'));
    assert.ok(!args.includes("--json-schema"));
    if (content[1])
      assert.deepEqual(content[1].source, {
        type: "base64",
        media_type: imageFixture.mimeType,
        data: imageFixture.data,
      });
    output({
      type: "result",
      subtype: "success",
      result: JSON.stringify(response(content[1])),
    });
  }
}
