import { string } from "./model.mjs";

export const agents = Object.freeze({
  codex: "Codex CLI",
  claude: "Claude Code CLI",
  gemini: "Gemini CLI",
});

export function isAgent(value) {
  return typeof value === "string" && Object.hasOwn(agents, value);
}

export function agentProfile(value, previous = {}) {
  const field = (key, limit) =>
    typeof value?.[key] === "string"
      ? value[key].trim().slice(0, limit)
      : (previous[key] ?? "");
  return {
    path: field("path", 1000),
    model: field("model", 150),
    effort: ["low", "medium", "high"].includes(value?.effort)
      ? value.effort
      : (previous.effort ?? "medium"),
  };
}

export function apiBaseUrl(value) {
  let url;
  try {
    url = new URL(string(value, "API 地址", 600));
  } catch {
    throw new Error("请输入完整的 API 地址，例如 https://服务地址/v1");
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error("API 地址不能包含账号、查询参数或片段");
  const loopback =
    ["localhost", "[::1]"].includes(url.hostname) ||
    /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error("外部模型地址请使用 HTTPS。本机回环地址支持 HTTP。");
  return url.href.replace(/\/$/, "").replace(/\/chat\/completions$/, "");
}
