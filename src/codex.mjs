import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, resolve, delimiter, isAbsolute, relative, sep } from "node:path";
import { tmpdir } from "node:os";

// Invoke the official CLI, never read or copy its authentication files.
export function findCodex(configured = "") {
  if (configured) {
    if (
      !isAbsolute(configured) ||
      !existsSync(configured) ||
      (process.platform === "win32" &&
        !configured.toLowerCase().endsWith(".exe"))
    )
      throw new Error("请指定已安装的 codex.exe 的完整路径");
    return configured;
  }
  const candidates = [];
  if (process.platform === "win32") {
    if (process.env.LOCALAPPDATA)
      candidates.push(
        join(
          process.env.LOCALAPPDATA,
          "Programs",
          "OpenAI",
          "Codex",
          "bin",
          "codex.exe",
        ),
      );
    for (const root of [
      process.env.APPDATA && join(process.env.APPDATA, "npm", "node_modules"),
      process.env.ProgramFiles &&
        join(process.env.ProgramFiles, "nodejs", "node_modules"),
    ].filter(Boolean)) {
      for (const folder of [
        join(root, "@openai", "codex"),
        join(
          root,
          "@openai",
          "codex",
          "node_modules",
          "@openai",
          "codex-win32-x64",
        ),
        join(root, "@openai", "codex-win32-x64"),
      ])
        candidates.push(
          join(
            folder,
            "vendor",
            "x86_64-pc-windows-msvc",
            "codex",
            "codex.exe",
          ),
        );
    }
  }
  for (const folder of (process.env.PATH ?? "").split(delimiter))
    if (folder)
      candidates.push(
        join(folder, process.platform === "win32" ? "codex.exe" : "codex"),
      );
  const path = candidates.find(existsSync);
  if (!path)
    throw new Error(
      "未找到 Codex CLI。请安装官方 Codex CLI，或在设置中指定 codex.exe 的路径。",
    );
  return path;
}
function environment() {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      (key.startsWith("CODEX_") && key !== "CODEX_HOME") ||
      ["OPENAI_API_KEY", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS"].includes(key)
    )
      delete env[key];
  return env;
}
function run(
  file,
  args,
  { cwd, input = "", signal, timeout = 300000, onLine } = {},
) {
  return new Promise((resolveResult, reject) => {
    if (signal?.aborted) return reject(new Error("已停止"));
    const child = spawn(file, args, {
      cwd,
      env: environment(),
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "",
      errorOutput = "",
      buffer = "",
      reason,
      closed = false;
    const stop = (message) => {
      reason = message;
      child.kill();
    };
    const abort = () => stop("已停止"),
      timer = setTimeout(() => stop("Codex 响应超时，请重试"), timeout);
    signal?.addEventListener("abort", abort, { once: true });
    const clean = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    child.on("error", () => {
      closed = true;
      clean();
      reject(new Error("无法启动 Codex CLI，请检查程序路径与系统权限"));
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      buffer += chunk;
      if (output.length > 6_000_000) {
        stop("Codex 输出过大");
        return;
      }
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        onLine?.(line);
      }
    });
    child.stderr.on("data", (chunk) => {
      errorOutput = (errorOutput + chunk).slice(-12000);
      onLine?.(String(chunk));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.on("close", (code) => {
      if (closed) return;
      clean();
      if (reason) return reject(new Error(reason));
      resolveResult({ code, output, errorOutput });
    });
  });
}
export async function codexStatus(settings = {}) {
  let path;
  try {
    path = findCodex(settings.codexPath);
  } catch (error) {
    return { available: false, loggedIn: false, message: error.message };
  }
  try {
    const version = await run(path, ["--version"], { timeout: 15000 }),
      auth = await run(path, ["login", "status"], { timeout: 15000 });
    const loggedIn =
      auth.code === 0 && /logged in/i.test(auth.output + auth.errorOutput);
    return {
      available: true,
      path,
      version: version.output.trim().slice(0, 80),
      loggedIn,
      account: loggedIn
        ? /chatgpt/i.test(auth.output + auth.errorOutput)
          ? "ChatGPT"
          : "Codex 登录凭据"
        : "",
      message: loggedIn
        ? "已登录，可以直接使用"
        : "尚未登录，请点击「登录 Codex」",
    };
  } catch (error) {
    return { available: false, loggedIn: false, path, message: error.message };
  }
}
export async function codexLogin(settings, { signal, emit = () => {} } = {}) {
  const path = findCodex(settings.codexPath);
  let collected = "",
    last = "";
  const result = await run(path, ["login", "--device-auth"], {
    signal,
    timeout: 300000,
    onLine: (line) => {
      collected = (collected + line + "\n")
        .replace(/\x1b\[[0-9;]*m/g, "")
        .slice(-10000);
      const url = collected.match(
          /https:\/\/(?:auth\.openai\.com|auth\.chatgpt\.com|chatgpt\.com)\/[^\s\x1b]+/,
        )?.[0],
        code = collected.match(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\b/)?.[0];
      if (url && code && last !== code) {
        last = code;
        emit({ type: "login", url, code });
      }
    },
  });
  if (result.code !== 0)
    throw new Error(
      "Codex 登录未完成。请重试；若账号未启用设备登录，可先在终端运行 codex login。",
    );
  return codexStatus(settings);
}
function cliError(text) {
  if (/401|unauthorized|not logged|authentication|login/i.test(text))
    return "Codex 登录已失效，请在模型设置中重新登录";
  if (/429|usage limit|quota|rate.limit/i.test(text))
    return "Codex 使用额度不足或请求过多，请稍后重试，也可以切换外部 API";
  if (/unknown|unexpected argument|unrecognized/i.test(text))
    return "Codex CLI 版本不兼容，请更新官方 CLI 后重试";
  if (/model.*(?:not|unsupported|unavailable)/i.test(text))
    return "当前账号无法使用所填模型，请清空 Codex 模型名称使用默认模型";
  return "Codex 未能完成本次请求，请检查登录状态、网络和模型设置后重试";
}
export async function codexCompletion(
  settings,
  prompt,
  { schema, image, signal, emit = () => {} } = {},
) {
  const executable = findCodex(settings.codexPath);
  const parent = resolve(
    settings.runtimeDir ?? join(tmpdir(), "housediy-codex"),
  );
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "request-"));
  try {
    const schemaFile = join(directory, "response-schema.json"),
      outputFile = join(directory, "response.json");
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
    for (const name of [
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
      args.push("--disable", name);
    args.push("--enable", "skip_host_skill_discovery");
    if (settings.codexModel) args.push("--model", settings.codexModel);
    if (settings.codexEffort)
      args.push("-c", `model_reasoning_effort="${settings.codexEffort}"`);
    if (image) {
      const match = image.dataUrl.match(
        /^data:image\/(png|jpeg|webp);base64,(.+)$/,
      );
      if (!match) throw new Error("图片格式无效");
      const imageFile = join(
        directory,
        "floorplan." + (match[1] === "jpeg" ? "jpg" : match[1]),
      );
      writeFileSync(imageFile, Buffer.from(match[2], "base64"));
      args.push("--image", imageFile);
    }
    args.push("-");
    let failure = "";
    emit({
      type: "status",
      text: image ? "Codex 正在分析户型图…" : "Codex 正在结合当前方案思考…",
    });
    const result = await run(executable, args, {
      cwd: directory,
      input: prompt,
      signal,
      timeout: image ? 420000 : 240000,
      onLine: (line) => {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.type === "turn.started")
          emit({
            type: "status",
            text: image ? "正在识别图纸并设计家具布局…" : "正在生成具体修改…",
          });
        if (event.type === "error" || event.type === "turn.failed")
          failure = JSON.stringify(event);
      },
    });
    if (result.code !== 0)
      throw new Error(cliError(failure + result.errorOutput));
    if (!existsSync(outputFile))
      throw new Error("Codex 没有返回完整结果，请重试");
    const raw = readFileSync(outputFile, "utf8");
    if (raw.length > 6_000_000) throw new Error("Codex 返回结果过大");
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("Codex 返回的设计数据不完整，请重试");
    }
  } finally {
    // Only remove the request directory created above, after the CLI has exited.
    const local = relative(parent, resolve(directory));
    if (local && !local.startsWith(".." + sep) && !isAbsolute(local))
      rmSync(directory, { recursive: true, force: true });
  }
}
