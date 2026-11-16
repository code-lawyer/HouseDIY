import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { Script } from "node:vm";

const entry = new URL("../public/index.html", import.meta.url);
const html = readFileSync(entry, "utf8");

test("local HTML entry can resolve its appearance and startup resources", () => {
  const references = [
    ...html.matchAll(/<(?:link|img|script)\b[^>]*(?:href|src)="([^"]+)"/g),
  ].map((match) => match[1]);
  assert.ok(references.length >= 3);
  for (const reference of references) {
    assert.ok(
      existsSync(new URL(reference, entry)),
      `Missing local entry resource: ${reference} resolves to ${new URL(reference, entry)}`,
    );
  }
});

test("local HTML entry gives desktop launch guidance before any app module runs", () => {
  const scriptTag = [...html.matchAll(/<script\b([^>]*)><\/script>/g)].find(
    (match) => !/type="module"/.test(match[1]),
  );
  assert.ok(
    scriptTag,
    "A classic bootstrap must run even when file module loading is blocked",
  );
  const source = scriptTag[1].match(/src="([^"]+)"/)[1];
  const guide = { hidden: true };
  const path = { textContent: "" };
  const classes = new Set();
  const script = new Script(readFileSync(new URL(source, entry), "utf8"));
  script.runInNewContext({
    URL,
    location: {
      protocol: "file:",
      href: "file:///D:/My%20House/public/index.html",
    },
    document: {
      body: { classList: { add: (name) => classes.add(name) } },
      querySelector: (selector) =>
        ({
          "#file-entry": guide,
          "#desktop-program-path": path,
        })[selector],
    },
  });
  assert.equal(guide.hidden, false);
  assert.equal(classes.has("file-preview"), true);
  assert.equal(path.textContent, "D:\\My House\\release");
  assert.match(html, /id="file-entry"/);
  assert.match(html, /HouseDIY-.*portable\.exe/);
});
