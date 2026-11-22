import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  dirname,
  delimiter,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { createInterface } from "node:readline";
import { agents } from "./provider-settings.mjs";

const windows = process.platform === "win32";
const npmPackages = {
  claude: ["@anthropic-ai", "claude-code"],
  gemini: ["@google", "gemini-cli"],
};
const maxOutputBytes = 6_000_000;

function pathFolders() {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .map((folder) => folder.replace(/^"|"$/g, ""))
    .filter(isAbsolute);
}

function npmBinary(root, kind) {
  const packageName = npmPackages[kind];
  const folder = resolve(root, ...packageName);
  try {
    const manifest = JSON.parse(
      readFileSync(join(folder, "package.json"), "utf8"),
    );
    if (manifest.name !== packageName.join("/")) return null;
    const command =
      typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[kind];
    if (typeof command !== "string") return null;
    const entry = resolve(folder, command);
    const local = relative(folder, entry);
    return local &&
      local !== ".." &&
      !local.startsWith(".." + sep) &&
      !isAbsolute(local)
      ? entry
      : null;
  } catch {
    return null;
  }
}

function discover(kind) {
  const filename = kind + (windows ? ".exe" : "");
  const folders = pathFolders();
  const paths = folders.map((folder) => join(folder, filename));
  paths.push(join(homedir(), ".local", "bin", filename));
  if (!windows) return paths;
  const { APPDATA, LOCALAPPDATA, ProgramFiles } = process.env;
  const npmRoots = [
    ...folders.map((folder) => join(folder, "node_modules")),
    APPDATA && join(APPDATA, "npm", "node_modules"),
    ProgramFiles && join(ProgramFiles, "nodejs", "node_modules"),
  ].filter(Boolean);
  if (kind === "codex") {
    if (LOCALAPPDATA)
      paths.unshift(
        join(LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin", filename),
      );
    const platform = ["vendor", "x86_64-pc-windows-msvc", "codex", filename];
    for (const root of npmRoots) {
      paths.push(
        join(root, "@openai", "codex", ...platform),
        join(root, "@openai", "codex-win32-x64", ...platform),
        join(
          root,
          "@openai",
          "codex",
          "node_modules",
          "@openai",
          "codex-win32-x64",
          ...platform,
        ),
      );
    }
  } else {
    for (const root of npmRoots) {
      const entry = npmBinary(root, kind);
      if (entry) paths.push(entry);
    }
  }
  if (kind === "claude" && LOCALAPPDATA) {
    const winget = join(LOCALAPPDATA, "Microsoft", "WinGet", "Packages");
    try {
      paths.push(
        ...readdirSync(winget)
          .filter((entry) => entry.startsWith("Anthropic.ClaudeCode_"))
          .map((entry) => join(winget, entry, filename)),
      );
    } catch (error) {
      if (!["ENOENT", "EACCES", "EPERM"].includes(error.code)) throw error;
    }
  }
  return paths;
}

export function agentExecutable(kind, configured = "") {
  const label = agents[kind];
  let location = configured || discover(kind).find(existsSync);
  if (!location)
    throw new Error(
      `未找到 ${label}。请在终端安装并登录，或指定程序的完整路径。`,
    );
  // npm uses .cmd shims on Windows. Resolve the official package entry instead
  // of passing a model name, prompt or path through a shell.
  if (
    windows &&
    npmPackages[kind] &&
    isAbsolute(location) &&
    /\.cmd$/i.test(location)
  )
    location = npmBinary(join(dirname(location), "node_modules"), kind) ?? "";
  if (
    !isAbsolute(location) ||
    !existsSync(location) ||
    (windows && !/\.(?:exe|[cm]?js)$/i.test(location))
  )
    throw new Error(
      `请指定已安装的 ${label} 可执行文件或官方 npm 入口的绝对路径。`,
    );
  if (!/\.[cm]?js$/i.test(location))
    return { kind, file: location, prefix: [] };
  const node = !process.versions.electron
    ? process.execPath
    : [
        ...pathFolders().map((dir) => join(dir, windows ? "node.exe" : "node")),
        windows &&
          process.env.ProgramFiles &&
          join(process.env.ProgramFiles, "nodejs", "node.exe"),
      ]
        .filter(Boolean)
        .find(existsSync);
  if (!node)
    throw new Error(
      `请先安装 Node.js 并将它加入 PATH，再使用 ${label} 的 npm 版本。`,
    );
  return { kind, file: node, prefix: [location] };
}

function environment(kind, extra) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    const name = key.toUpperCase();
    // Keep Claude Code's own authentication selection. HouseDIY does not
    // populate these variables with any credentials from its model settings.
    if (
      kind === "claude" &&
      (name.startsWith("ANTHROPIC_") ||
        name.startsWith("CLAUDE_CODE_USE_") ||
        name === "CLAUDE_CODE_OAUTH_TOKEN" ||
        name === "GOOGLE_APPLICATION_CREDENTIALS")
    )
      continue;
    if (
      (name.startsWith("CODEX_") && name !== "CODEX_HOME") ||
      (name.startsWith("CLAUDE_CODE_") &&
        name !== "CLAUDE_CODE_MAX_OUTPUT_TOKENS") ||
      name.startsWith("ANTHROPIC_") ||
      name.startsWith("GEMINI_TELEMETRY_") ||
      [
        "OPENAI_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_GENAI_USE_VERTEXAI",
        "GOOGLE_GENAI_USE_GCA",
        "CODE_ASSIST_ENDPOINT",
        "NODE_OPTIONS",
        "NODE_TLS_REJECT_UNAUTHORIZED",
        "ELECTRON_RUN_AS_NODE",
      ].includes(name)
    )
      delete env[key];
  }
  return Object.assign(env, { NO_COLOR: "1" }, extra);
}

export function runCli(
  command,
  args,
  { cwd, input = "", signal, timeout = 15000, onLine, protocol, env } = {},
) {
  return new Promise((resolveResult, reject) => {
    signal?.throwIfAborted();
    const child = spawn(command.file, [...command.prefix, ...args], {
      cwd,
      env: environment(command.kind, env),
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "",
      stderr = "",
      bytes = 0,
      stopped;
    const stop = (error) => {
      stopped ??= error;
      child.kill();
    };
    const abort = () => stop(signal.reason ?? new Error("已停止"));
    const timer = setTimeout(
      () => stop(new Error("CLI 响应超时，请重试")),
      timeout,
    );
    const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
    const finish = () => child.stdin.end();
    const reader = createInterface({ input: child.stdout });
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) stop(new Error("CLI 返回结果过大"));
    });
    reader.on("line", (line) => {
      if (stopped) return;
      if (!protocol) output += line + "\n";
      try {
        protocol?.receive(line, { send, finish });
        onLine?.(line);
      } catch (error) {
        stop(error);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-12000);
    });
    child.stdin.on("error", () => {});
    child.on("error", () => {
      stopped ??= new Error("无法启动 CLI，请检查程序路径和系统权限");
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (stopped) reject(stopped);
      else resolveResult({ code, output, stderr });
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else if (protocol) protocol.start(send);
    else child.stdin.end(input);
  });
}

export async function withAgentDirectory(runtimeDir, work) {
  const root = resolve(runtimeDir ?? join(tmpdir(), "housediy-agent"));
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "request-"));
  try {
    return await work(directory);
  } finally {
    // directory was created by this invocation and is never supplied by the model.
    rmSync(directory, { recursive: true, force: true, maxRetries: 2 });
  }
}

export function cliError(kind, detail) {
  const name = agents[kind];
  if (
    /401|unauthorized|not logged|authenticat|sign.?in|login|oauth/i.test(detail)
  )
    return `请先在本机终端登录 ${name}，然后重试`;
  if (/429|usage limit|quota|rate.limit/i.test(detail))
    return `${name} 使用额度不足或请求过多，请稍后重试`;
  if (
    /unknown (?:argument|option)|unexpected argument|unrecognized/i.test(detail)
  )
    return `当前 ${name} 版本不兼容，请更新官方 CLI 后重试`;
  if (/model.*(?:not|unsupported|unavailable)/i.test(detail))
    return `当前账号无法使用所选模型，请留空模型名以使用 CLI 默认值`;
  return `${name} 未能完成请求，请检查本机登录、网络和模型设置`;
}

export function cleanOldAgentRequests(runtimeDir) {
  const root = resolve(runtimeDir);
  if (!lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) return;
  const before = Date.now() - 24 * 60 * 60 * 1000;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^request-[a-zA-Z0-9]{6}$/.test(entry.name))
      continue;
    const file = join(root, entry.name);
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.mtimeMs >= before) continue;
    try {
      rmSync(file, { recursive: true, force: true });
    } catch {
      // An open directory can be retried at the next startup.
    }
  }
}
