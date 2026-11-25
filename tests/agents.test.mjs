import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { agentCompletion, agentStatus } from "../src/agents.mjs";
import { chatSchema } from "../src/schemas.mjs";
import { apiBaseUrl } from "../src/provider-settings.mjs";
import { agentExecutable } from "../src/agent-process.mjs";

const path = fileURLToPath(
  new URL("./fixtures/local-agent.mjs", import.meta.url),
);
for (const agent of ["codex", "claude", "gemini"]) {
  test(`${agent} sends text and image to a restricted local CLI and normalizes replies`, async (t) => {
    mkdirSync(".qa", { recursive: true });
    const runtimeDir = mkdtempSync(resolve(".qa/agent-"));
    t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
    const status = await agentStatus(agent, { path });
    assert.equal(status.available, true);
    assert.equal(status.loggedIn, agent === "gemini" ? null : true);
    assert.equal(status.version, "3.1.2");
    assert.ok(!JSON.stringify(status).includes("private-test"));
    const settings = {
      provider: "agent",
      agent,
      agents: { [agent]: { path } },
      runtimeDir,
    };
    for (const image of [
      undefined,
      { dataUrl: "data:image/png;base64,AA==" },
    ]) {
      const result = await agentCompletion(settings, "synthetic plan", {
        schema: chatSchema,
        image,
      });
      assert.deepEqual(result, {
        reply: image ? "fixture image" : "fixture text",
        operations: [],
      });
    }
    assert.deepEqual(readdirSync(runtimeDir), []);
  });
}

test("external endpoints use HTTPS except for literal loopback hosts", () => {
  assert.equal(
    apiBaseUrl("https://llm.example/v1/chat/completions"),
    "https://llm.example/v1",
  );
  for (const url of [
    "http://localhost/v1",
    "http://127.0.0.1:2",
    "http://[::1]/v1",
  ])
    assert.equal(apiBaseUrl(url), url);
  for (const url of [
    "http://192.168.1.1/v1",
    "http://example.test",
    "https://user@host.test/v1",
    "file:///v1",
  ])
    assert.throws(() => apiBaseUrl(url));
});

test(
  "Windows resolves the installed Gemini npm entry without executing the command shim",
  {
    skip: process.platform !== "win32",
  },
  (t) => {
    const prefix = mkdtempSync(resolve(".qa/cli-prefix-"));
    t.after(() => rmSync(prefix, { recursive: true, force: true }));
    const folder = join(prefix, "node_modules", "@google", "gemini-cli");
    mkdirSync(join(folder, "bundle"), { recursive: true });
    const entry = join(folder, "bundle", "gemini.js");
    writeFileSync(entry, "");
    writeFileSync(
      join(folder, "package.json"),
      JSON.stringify({
        name: "@google/gemini-cli",
        bin: { gemini: "bundle/gemini.js" },
      }),
    );
    assert.deepEqual(agentExecutable("gemini", join(prefix, "gemini.cmd")), {
      kind: "gemini",
      file: process.execPath,
      prefix: [entry],
    });
  },
);
