const { existsSync } = require("node:fs");
const { join, resolve } = require("node:path");

// Keep the existing profile in place so its projects and OS-encrypted settings
// remain usable. Never copy or merge two workspaces during startup.
function resolveUserDataDir({ appData, defaultDir, overrideDir }) {
  if (overrideDir) return resolve(overrideDir);
  if (existsSync(join(defaultDir, "workspace", "projects"))) return defaultDir;
  const legacyDir = join(appData, "MyHouse");
  return existsSync(join(legacyDir, "workspace", "projects"))
    ? legacyDir
    : defaultDir;
}

module.exports = { resolveUserDataDir };
