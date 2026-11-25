import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agents, agentProfile, isAgent } from "./provider-settings.mjs";
import {
  agentExecutable,
  cliError,
  runCli,
  withAgentDirectory,
} from "./agent-process.mjs";
import { geminiCompletion } from "./gemini.mjs";

export function agentImage(image) {
  if (!image) return null;
  const imageParts = image.dataUrl.match(
    /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/,
  );
  if (!imageParts) throw new Error("图片格式无效");
  return { mimeType: imageParts[1], data: imageParts[2] };
}

function designJson(value) {
  try {
    const result =
      typeof value === "string"
        ? JSON.parse(
            value
              .trim()
              .replace(/^```(?:json)?\s*/i, "")
              .replace(/\s*```$/, ""),
          )
        : value;
    if (result && typeof result === "object" && !Array.isArray(result))
      return result;
  } catch {
    // Report a stable error without sending CLI diagnostics or prompts back to the UI.
  }
  throw new Error("CLI 未返回完整的设计数据，请重试或换用支持此任务的模型");
}

export async function agentStatus(kind, config, signal) {
  if (!isAgent(kind)) throw new Error("请选择支持的本机 Agent");
  const profile = agentProfile(config);
  const name = agents[kind];
  try {
    const cli = agentExecutable(kind, profile.path);
    const version = await runCli(cli, ["--version"], { signal });
    if (version.code !== 0)
      throw new Error(`无法识别 ${name} 的版本，请确认安装或更新`);
    const versionLabel =
      version.output.match(/\bv?\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0] ?? "";
    if (kind === "gemini")
      return {
        available: true,
        loggedIn: null,
        version: versionLabel,
        message:
          "已找到 Gemini CLI。需要已登录的组织 Code Assist 账号，发送时验证资格。",
      };
    const auth = await runCli(
      cli,
      kind === "codex" ? ["login", "status"] : ["auth", "status"],
      { signal },
    );
    const loggedIn =
      auth.code === 0 &&
      (kind === "codex"
        ? /logged in/i.test(auth.output + auth.stderr)
        : /"loggedIn"\s*:\s*true/.test(auth.output));
    return {
      available: true,
      loggedIn,
      version: versionLabel,
      message: loggedIn ? "已登录，可以使用本机账号" : `请先在终端登录 ${name}`,
    };
  } catch (error) {
    signal?.throwIfAborted();
    return { available: false, loggedIn: false, message: error.message };
  }
}

async function codexCompletion(
  cli,
  profile,
  directory,
  prompt,
  { schema, image, signal, timeout },
) {
  const schemaFile = join(directory, "response-schema.json");
  const outputFile = join(directory, "response.json");
  writeFileSync(schemaFile, JSON.stringify(schema), "utf8");
  const args = [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--json",
    "--color",
    "never",
    "--cd",
    directory,
    "--output-schema",
    schemaFile,
    "--output-last-message",
    outputFile,
    "-c",
    'approval_policy="never"',
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    'web_search="disabled"',
  ];
  for (const feature of [
    "shell_tool",
    "apps",
    "plugins",
    "multi_agent",
    "browser_use",
    "computer_use",
    "view_image",
    "image_generation",
    "memories",
    "hooks",
    "code_mode_host",
    "skill_search",
    "workspace_dependencies",
    "in_app_browser",
  ])
    args.push("--disable", feature);
  args.push("--enable", "skip_host_skill_discovery");
  if (profile.model) args.push("--model", profile.model);
  args.push("-c", `model_reasoning_effort="${profile.effort}"`);
  if (image) {
    const imageFile = join(
      directory,
      "floorplan." + image.mimeType.split("/")[1],
    );
    writeFileSync(imageFile, Buffer.from(image.data, "base64"));
    args.push("--image", imageFile);
  }
  const result = await runCli(cli, [...args, "-"], {
    cwd: directory,
    input: prompt,
    signal,
    timeout,
  });
  if (result.code !== 0)
    throw new Error(cliError("codex", result.output + result.stderr));
  try {
    const raw = readFileSync(outputFile, "utf8");
    if (raw.length > 6_000_000) throw new Error("Codex CLI 返回结果过大");
    return raw;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error("Codex CLI 未返回完整结果，请重试");
  }
}

async function claudeCompletion(
  cli,
  profile,
  directory,
  prompt,
  { schema, image, signal, timeout },
) {
  const args = [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--safe-mode",
    "--max-turns",
    "2",
    "--tools",
    "",
    "--disallowedTools",
    "mcp__*",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--setting-sources",
    "",
    "--no-session-persistence",
    "--system-prompt",
    "You return structured HouseDIY design data using the input provided.",
    "--settings",
    '{"disableAllHooks":true,"autoMemoryEnabled":false}',
  ];
  if (profile.model) args.push("--model", profile.model);
  // The Codex schema uses keywords Claude structured mode does not support.
  // Keep it as prompt guidance and validate replies in the design pipeline.
  const content = [
    {
      type: "text",
      text:
        prompt +
        "\n只输出一个合法 JSON 对象，字段结构为：\n" +
        JSON.stringify(schema),
    },
  ];
  if (image)
    content.push({
      type: "image",
      source: { type: "base64", media_type: image.mimeType, data: image.data },
    });
  const input =
    JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
  let response;
  const command = await runCli(cli, args, {
    cwd: directory,
    input,
    signal,
    timeout,
    env: {
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    },
    onLine(line) {
      try {
        const event = JSON.parse(line);
        if (event.type === "result") response = event;
      } catch {
        // Ignore output that is not a Claude Code result event.
      }
    },
  });
  if (
    command.code !== 0 ||
    !response ||
    response.is_error ||
    response.subtype !== "success"
  )
    throw new Error(
      cliError("claude", command.stderr + JSON.stringify(response ?? {})),
    );
  return response.structured_output ?? response.result;
}

export async function agentCompletion(
  settings,
  prompt,
  { schema, image, signal, emit = () => {} },
) {
  const kind = settings.agent ?? "codex";
  if (!isAgent(kind)) throw new Error("请选择支持的本机 Agent");
  const profile = agentProfile(settings.agents?.[kind]);
  if (profile.model.startsWith("-"))
    throw new Error("请输入有效的 CLI 模型名称");
  const cli = agentExecutable(kind, profile.path);
  const complete = {
    codex: codexCompletion,
    claude: claudeCompletion,
    gemini: geminiCompletion,
  }[kind];
  emit({
    type: "status",
    text: `${agents[kind]} 正在${image ? "分析户型图" : "处理设计请求"}…`,
  });
  const raw = await withAgentDirectory(settings.runtimeDir, (directory) =>
    complete(cli, profile, directory, prompt, {
      schema,
      image: agentImage(image),
      signal,
      timeout: image ? 420000 : 240000,
    }),
  );
  return designJson(raw);
}
