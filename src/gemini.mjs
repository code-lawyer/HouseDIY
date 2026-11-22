import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliError, runCli } from "./agent-process.mjs";

// Gemini ACP accepts inline image data. HouseDIY supplies neither filesystem nor
// terminal methods and denies permission requests rather than forwarding them.
export async function geminiCompletion(
  cli,
  profile,
  directory,
  prompt,
  { schema, image, signal, timeout },
) {
  const policy = join(directory, "design-only.toml");
  writeFileSync(
    policy,
    '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n',
    "utf8",
  );
  const config = join(directory, ".gemini");
  mkdirSync(config);
  writeFileSync(
    join(config, "settings.json"),
    JSON.stringify({
      context: { fileName: "HOUSEDIY_NO_CONTEXT.md" },
      general: { enableAutoUpdate: false },
      hooksConfig: { enabled: false },
      skills: { enabled: false },
      telemetry: { enabled: false },
      tools: { core: ["housediy_no_tools"] },
    }),
    "utf8",
  );

  const args = [
    "--acp",
    "--skip-trust",
    "--approval-mode",
    "default",
    "--extensions",
    "none",
    "--allowed-mcp-server-names",
    "housediy-no-servers",
    "--admin-policy",
    policy,
  ];
  if (profile.model) args.push("--model", profile.model);
  const content = [
    {
      type: "text",
      text:
        prompt.replaceAll("@", "＠") +
        "\n输出单个 JSON 对象，遵循此结构：\n" +
        JSON.stringify(schema),
    },
  ];
  if (image) content.push({ type: "image", ...image });

  let sessionId,
    response = "",
    complete = false;
  const request = (send, id, method, params) =>
    send({ jsonrpc: "2.0", id, method, params });
  const protocol = {
    start(send) {
      request(send, 1, "initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "housediy", version: "1" },
      });
    },
    receive(line, { send, finish }) {
      if (!line.startsWith("{")) return;
      const event = JSON.parse(line);
      if (event.method === "session/request_permission" && event.id != null) {
        send({
          jsonrpc: "2.0",
          id: event.id,
          result: { outcome: { outcome: "cancelled" } },
        });
      } else if (event.method && event.id != null) {
        send({
          jsonrpc: "2.0",
          id: event.id,
          error: { code: -32601, message: "Method not available" },
        });
      } else if (!event.method && [1, 2, 3].includes(event.id) && event.error) {
        throw new Error(cliError("gemini", JSON.stringify(event.error)));
      } else if (!event.method && event.id === 1) {
        if (event.result?.protocolVersion !== 1)
          throw new Error("Gemini CLI 的 ACP 协议版本不兼容，请更新后重试");
        if (image && !event.result.agentCapabilities?.promptCapabilities?.image)
          throw new Error(
            "当前 Gemini CLI 不支持通过 ACP 接收图片，请更新 CLI",
          );
        request(send, 2, "session/new", { cwd: directory, mcpServers: [] });
      } else if (!event.method && event.id === 2) {
        sessionId = event.result?.sessionId;
        if (typeof sessionId !== "string")
          throw new Error("Gemini CLI 没有建立会话，请确认终端已经登录");
        request(send, 3, "session/prompt", { sessionId, prompt: content });
      } else if (
        event.method === "session/update" &&
        event.params?.sessionId === sessionId
      ) {
        const update = event.params.update;
        if (
          update?.sessionUpdate === "agent_message_chunk" &&
          update.content?.type === "text"
        )
          response += update.content.text;
      } else if (!event.method && event.id === 3) {
        if (event.result?.stopReason !== "end_turn")
          throw new Error("Gemini CLI 提前结束了请求，请重试或缩小任务范围");
        complete = true;
        finish();
      }
    },
  };
  const result = await runCli(cli, args, {
    cwd: directory,
    signal,
    timeout,
    protocol,
    env: { NO_BROWSER: "true" },
  });
  if (result.code !== 0 || !complete)
    throw new Error(cliError("gemini", result.stderr));
  return response;
}
