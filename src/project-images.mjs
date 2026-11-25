import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { id } from "./model.mjs";

const digestPattern = /^[a-f0-9]{64}$/;
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function createProjectImages(workspace) {
  const directory = join(workspace, "images");
  function pathFor(hash) {
    if (typeof hash !== "string" || !digestPattern.test(hash))
      throw new Error("图片附件编号无效");
    return join(directory, `source-${hash}.txt`);
  }

  function store(data) {
    const hash = digest(data);
    const target = pathFor(hash);
    mkdirSync(directory, { recursive: true });
    if (existsSync(target) && readFileSync(target, "utf8") === data)
      return hash;
    const temp = target + "." + id() + ".tmp";
    try {
      writeFileSync(temp, data, { encoding: "utf8", flush: true });
      renameSync(temp, target);
    } finally {
      rmSync(temp, { force: true });
    }
    return hash;
  }

  function load(hash) {
    const file = pathFor(hash);
    try {
      const data = readFileSync(file, "utf8");
      if (digest(data) === hash) return data;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const error = new Error(
      `图片附件 source-${hash}.txt 缺失或校验失败，请从备份恢复到 workspace/images。`,
    );
    error.status = 422;
    throw error;
  }

  function pack(project) {
    let { image, underlay } = project;
    if (image?.originalDataUrl) {
      const { originalDataUrl, ...rest } = image;
      image = {
        ...rest,
        originalSha256: store(originalDataUrl),
        originalAvailable: true,
      };
    }
    if (image?.dataUrl) {
      const { dataUrl, ...rest } = image;
      const dataSha256 =
        dataUrl === project.image.originalDataUrl
          ? image.originalSha256
          : store(dataUrl);
      image = { ...rest, dataSha256 };
    }
    if (underlay?.src) {
      const { src, ...rest } = underlay;
      underlay = {
        ...rest,
        srcSha256:
          src === project.image?.dataUrl ? image.dataSha256 : store(src),
      };
    }
    return { ...project, image, underlay };
  }

  function loadUnderlay(underlay) {
    if (!underlay?.srcSha256) return underlay;
    const { srcSha256, ...rest } = underlay;
    return { ...rest, src: load(srcSha256) };
  }

  function unpack(project) {
    let { image, underlay } = project;
    if (image?.dataSha256) {
      const { dataSha256, ...rest } = image;
      image = { ...rest, dataUrl: load(dataSha256) };
      if (underlay?.srcSha256 === dataSha256) {
        const { srcSha256, ...calibration } = underlay;
        underlay = { ...calibration, src: image.dataUrl };
      }
    }
    return { ...project, image, underlay: loadUnderlay(underlay) };
  }

  function hashes(project) {
    const { image, underlay } = project;
    if (
      [image, underlay].some(
        (part) =>
          part != null && (typeof part !== "object" || Array.isArray(part)),
      )
    )
      throw new Error("无法确认项目的图片引用");
    return [
      image?.originalSha256,
      image?.dataSha256,
      underlay?.srcSha256,
    ].filter((hash) => {
      if (hash == null) return false;
      pathFor(hash);
      return true;
    });
  }

  function prune(readProjects, candidates) {
    if (!existsSync(directory) || candidates?.size === 0) return;
    try {
      const unused = candidates
        ? new Set(candidates)
        : new Set(
            readdirSync(directory)
              .map((name) => /^source-([a-f0-9]{64})\.txt$/.exec(name)?.[1])
              .filter(Boolean),
          );
      if (!unused.size) return;
      for (const project of readProjects())
        for (const hash of hashes(project)) unused.delete(hash);
      for (const hash of unused) rmSync(pathFor(hash), { force: true });
    } catch {
      // Unreadable project metadata or a locked file defers reclamation until the next pass.
    }
  }
  return { pack, unpack, loadUnderlay, load, prune, hashes };
}
