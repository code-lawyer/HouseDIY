import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const readJson = (path) =>
  JSON.parse(readFileSync(new URL(path, root), "utf8"));
const manifest = readJson("package.json");
const lock = readJson("package-lock.json");

for (const name of Object.keys(manifest.devDependencies)) {
  const path = `node_modules/${name}`;
  const expected = lock.packages[path].version;
  let installed;
  try {
    installed = readJson(`${path}/package.json`).version;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (installed !== expected) {
    throw new Error(
      `${name}: found ${installed ?? "no installation"}, expected ${expected} from package-lock.json. Run npm ci before building.`,
    );
  }
}
