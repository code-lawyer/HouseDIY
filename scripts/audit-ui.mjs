// Measured shell contrast/layout checks. The 3D canvas needs separate visual QA.
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { startServer } from "../src/server.mjs";
const directory = resolve(process.env.HOUSEDIY_AUDIT_DIR || ".qa/audit");
mkdirSync(directory, { recursive: true });
const app = await startServer({
  dataDir: mkdtempSync(join(directory, "audit-data-")),
});
const browser = await puppeteer.launch({
  executablePath: [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ].find(existsSync),
  headless: true,
  args: [
    "--no-proxy-server",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ],
  defaultViewport: { width: 1366, height: 768 },
});
const results = [];
try {
  const page = await browser.newPage();
  const inspect = async (name) => {
    const data = await page.evaluate(() => {
      const root = document.querySelector("dialog[open]") || document.body;
      const color = (text) => (text.match(/[\d.]+/g) || []).map(Number);
      const blend = (fg, bg) =>
        fg
          .slice(0, 3)
          .map((n, i) => n * (fg[3] ?? 1) + bg[i] * (1 - (fg[3] ?? 1)));
      const background = (element) => {
        if (!element) return [255, 255, 255];
        const c = color(getComputedStyle(element).backgroundColor);
        return c.length >= 3
          ? blend(c, background(element.parentElement))
          : background(element.parentElement);
      };
      const luminance = (rgb) =>
        rgb
          .map((n) => {
            n /= 255;
            return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
          })
          .reduce((a, n, i) => a + n * [0.2126, 0.7152, 0.0722][i], 0);
      const contrasts = [],
        unlabeled = [];
      for (const el of root.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (
          !el.checkVisibility() ||
          r.width < 2 ||
          r.height < 2 ||
          r.bottom < 0 ||
          r.top >= innerHeight ||
          el.closest("[inert]")
        )
          continue;
        const s = getComputedStyle(el);
        let text = [...el.childNodes]
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent)
          .join("")
          .trim();
        if (el.matches("input,textarea")) text = el.value || el.placeholder;
        if (!text) continue;
        const bg = background(el);
        const style =
          el.matches("input,textarea") && !el.value && el.placeholder
            ? getComputedStyle(el, "::placeholder")
            : s;
        const fg = blend(color(style.color), bg),
          a = luminance(fg),
          b = luminance(bg);
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        const size = parseFloat(s.fontSize),
          minimum =
            size >= 24 || (size >= 18.66 && parseFloat(s.fontWeight) >= 700)
              ? 3
              : 4.5;
        contrasts.push({
          element: el.id || el.tagName + "." + el.className,
          text: text.slice(0, 45),
          size,
          ratio: Math.round(ratio * 100) / 100,
          pass: ratio >= minimum,
        });
      }
      for (const el of root.querySelectorAll(
        "button,input:not([hidden]),select,textarea,dialog[open]",
      )) {
        if (!el.checkVisibility()) continue;
        const named =
          el.getAttribute("aria-label") ||
          el.getAttribute("aria-labelledby") ||
          el.labels?.length ||
          (el.tagName === "BUTTON" && (el.textContent.trim() || el.title));
        if (!named) unlabeled.push(el.id || el.tagName);
      }
      return {
        contrasts,
        failures: contrasts.filter((x) => !x.pass),
        unlabeled,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    results.push({ name, ...data });
  };
  await page.goto(app.url);
  await page.waitForSelector(".project-card");
  await inspect("home");
  await page.click("#settings-button");
  await page.waitForFunction(
    () =>
      !document.querySelector("#codex-status").textContent.includes("正在检测"),
  );
  await inspect("settings-codex");
  await page.select("#model-provider", "api");
  await inspect("settings-api");
  await page.$eval("#settings-result", (element) => {
    element.textContent = "连接失败，请检查服务地址或模型名称后重试。";
    element.classList.add("error");
  });
  await inspect("settings-error");
  await page.keyboard.press("Escape");
  await page.click("#new-project");
  await inspect("import");
  await page.keyboard.press("Escape");
  await page.click(".project-card");
  await page.waitForFunction(
    () => document.querySelector("#editor-loading").hidden,
  );
  await inspect("editor-shell");
  // Stress actual text bounds without changing persisted product data.
  await page.$eval(
    "#project-name",
    (e) => (e.textContent = "这是一个很长的项目名称".repeat(12)),
  );
  await page.setViewport({ width: 1120, height: 760 });
  await inspect("long-project-name");
  console.log(
    JSON.stringify(
      results.map((r) => ({
        name: r.name,
        textChecks: r.contrasts.length,
        failures: r.failures,
        unlabeled: r.unlabeled,
        overflow: r.overflow,
      })),
    ),
  );
} finally {
  writeFileSync(
    join(directory, "ui-measurements.json"),
    JSON.stringify(results, null, 2),
  );
  await browser.close();
  await app.close();
}
