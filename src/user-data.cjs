const { existsSync, readdirSync } = require("node:fs");
const { join, resolve } = require("node:path");

function hasWorkspace(profile) {
  const workspace = join(profile, "workspace");
  if (existsSync(join(workspace, "workspace-initialized.json"))) return true;
  try {
    if (
      readdirSync(join(workspace, "projects")).some((name) =>
        name.endsWith(".json"),
      )
    )
      return true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return false;
}

// Keep the existing profile in place so its projects and OS-encrypted settings
// remain usable. Never copy or merge two workspaces during startup.
function resolveUserDataDir({ appData, defaultDir, overrideDir }) {
  if (overrideDir) return resolve(overrideDir);
  if (hasWorkspace(defaultDir)) return defaultDir;
  const legacyDir = join(appData, "MyHouse");
  if (hasWorkspace(legacyDir)) return legacyDir;
  if (
    !existsSync(join(defaultDir, "workspace", "settings.json")) &&
    existsSync(join(legacyDir, "workspace", "settings.json"))
  )
    return legacyDir;
  return defaultDir;
}

module.exports = { resolveUserDataDir };
