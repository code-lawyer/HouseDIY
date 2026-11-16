import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { resolveUserDataDir } from "../src/user-data.cjs";

test("rebranding opens the existing workspace without copying or overwriting data", (t) => {
  const appData = mkdtempSync(join(tmpdir(), "housediy-profile-"));
  t.after(() => rmSync(appData, { recursive: true, force: true }));
  const defaultDir = join(appData, "HouseDIY");
  const legacyDir = join(appData, "MyHouse");
  const options = { appData, defaultDir };
  assert.equal(resolveUserDataDir(options), defaultDir);
  mkdirSync(join(legacyDir, "workspace", "projects"), { recursive: true });
  const project = join(legacyDir, "workspace", "projects", "example.json");
  writeFileSync(project, '{"preserved":true}');
  assert.equal(resolveUserDataDir(options), legacyDir);
  assert.equal(readFileSync(project, "utf8"), '{"preserved":true}');
  assert.equal(
    resolveUserDataDir({ ...options, overrideDir: ".qa/isolated" }),
    resolve(".qa/isolated"),
  );
  mkdirSync(join(defaultDir, "workspace", "projects"), { recursive: true });
  assert.equal(resolveUserDataDir(options), defaultDir);
  assert.equal(readFileSync(project, "utf8"), '{"preserved":true}');
});
