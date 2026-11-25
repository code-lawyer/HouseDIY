import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

export async function holdFileWithoutDeleteSharing(file) {
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference = 'Stop'
       $stream = [IO.File]::Open($env:HOUSEDIY_QA_LOCK_FILE, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
       try {
         [Console]::WriteLine('LOCKED')
         [void][Console]::ReadLine()
       } finally { $stream.Dispose() }`,
    ],
    {
      windowsHide: true,
      env: { ...process.env, HOUSEDIY_QA_LOCK_FILE: file },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let errorOutput = "";
  child.stderr.on("data", (data) => (errorOutput += data));
  const closed = once(child, "close");
  try {
    const result = await Promise.race([
      once(child.stdout, "data", { signal: AbortSignal.timeout(10000) }),
      closed.then(() => {
        throw new Error(
          "Could not lock a fixture project: " + errorOutput.trim(),
        );
      }),
    ]);
    assert.match(result[0].toString(), /LOCKED/);
  } catch (error) {
    child.kill();
    await closed.catch(() => {});
    throw error;
  }
  return async () => {
    child.stdin.end();
    const [code] = await closed;
    assert.equal(code, 0, errorOutput);
  };
}
