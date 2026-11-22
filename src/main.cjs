const {
  app,
  BrowserWindow,
  Menu,
  safeStorage,
  session,
  dialog,
  ipcMain,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { resolveUserDataDir } = require("./user-data.cjs");
app.setName("HouseDIY");
app.setPath(
  "userData",
  resolveUserDataDir({
    appData: app.getPath("appData"),
    defaultDir: path.join(app.getPath("appData"), "HouseDIY"),
    overrideDir: process.env.HOUSEDIY_DATA_DIR || process.env.MYHOUSE_DATA_DIR,
  }),
);
if (process.env.HOUSEDIY_QA_PORT && process.env.HOUSEDIY_DATA_DIR) {
  app.commandLine.appendSwitch(
    "remote-debugging-port",
    process.env.HOUSEDIY_QA_PORT,
  );
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}
if (process.env.HOUSEDIY_SOFTWARE_GPU)
  app.commandLine.appendSwitch("use-angle", "swiftshader");
const locked = app.requestSingleInstanceLock();
let window,
  service,
  closing = false;
if (!locked) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app
    .whenReady()
    .then(async () => {
      const { startServer } = await import("./server.mjs");
      const { maxPlanFileBytes } = await import("./model-assets.mjs");
      const { cleanOldAgentRequests } = await import("./agent-process.mjs");
      const workspace = path.join(app.getPath("userData"), "workspace");
      try {
        cleanOldAgentRequests(path.join(workspace, "requests"));
      } catch {
        // A temporarily unavailable requests folder cannot block workspace opening.
      }
      const codec = (await safeStorage.isAsyncEncryptionAvailable())
        ? {
            encrypt: async (text) =>
              (await safeStorage.encryptStringAsync(text)).toString("base64"),
            decrypt: async (text) =>
              (
                await safeStorage.decryptStringAsync(
                  Buffer.from(text, "base64"),
                )
              ).result,
          }
        : undefined;
      service = await startServer({
        dataDir: workspace,
        secretCodec: codec,
        seedFile: process.env.HOUSEDIY_SEED,
      });
      session.defaultSession.setPermissionRequestHandler(
        (_contents, _permission, callback) => callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      window = new BrowserWindow({
        width: 1640,
        height: 1040,
        minWidth: 1120,
        minHeight: 760,
        title: "HouseDIY · AI 家居设计",
        icon: path.join(__dirname, "../public/logo.png"),
        backgroundColor: "#f3f5f8",
        show: !process.env.HOUSEDIY_QA_HIDDEN,
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          spellcheck: false,
          backgroundThrottling: !process.env.HOUSEDIY_QA_HIDDEN,
        },
      });
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: "文件",
            submenu: [
              {
                label: "返回项目",
                click: () => window.webContents.send("go-home"),
              },
              { type: "separator" },
              { role: "quit", label: "退出" },
            ],
          },
          {
            label: "编辑",
            submenu: [
              { role: "undo", label: "撤销" },
              { role: "redo", label: "重做" },
              { type: "separator" },
              { role: "cut", label: "剪切" },
              { role: "copy", label: "复制" },
              { role: "paste", label: "粘贴" },
              { role: "selectAll", label: "全选" },
            ],
          },
          {
            label: "窗口",
            submenu: [
              { role: "minimize", label: "最小化" },
              { role: "togglefullscreen", label: "全屏" },
            ],
          },
        ]),
      );
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event, url) => {
        if (!url.startsWith(service.origin + "/")) event.preventDefault();
      });
      window.webContents.on("will-attach-webview", (event) =>
        event.preventDefault(),
      );
      ipcMain.handle("export-plan", async (event, { name, text }) => {
        if (
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame
        )
          throw new Error("无效请求");
        if (
          typeof text !== "string" ||
          Buffer.byteLength(text) > maxPlanFileBytes
        )
          throw new Error("方案超过 96 MB，请备份整个 workspace 目录");
        const result = await dialog.showSaveDialog(window, {
          defaultPath: String(name).replace(/[<>:"/\\|?*]/g, "_") + ".json",
          filters: [{ name: "设计方案", extensions: ["json"] }],
        });
        if (!result.canceled) {
          fs.writeFileSync(result.filePath, text, "utf8");
          return true;
        }
        return false;
      });
      window.webContents.on("did-fail-load", (_event, code, description) => {
        if (code !== -3) console.error("Page load failed", code, description);
      });
      await window.loadURL(service.url);
      if (process.env.HOUSEDIY_QA_INFO)
        fs.writeFileSync(
          process.env.HOUSEDIY_QA_INFO,
          JSON.stringify({
            origin: service.origin,
            port: process.env.HOUSEDIY_QA_PORT,
            pid: process.pid,
          }),
        );
      window.on("close", (event) => {
        if (closing) return;
        event.preventDefault();
        window.webContents.send("request-close");
      });
      ipcMain.on("close-ready", (event) => {
        if (event.sender === window.webContents) {
          closing = true;
          window.close();
        }
      });
    })
    .catch((error) => {
      dialog.showErrorBox("HouseDIY 无法启动", error.message);
      app.quit();
    });
  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", () => {
    service?.server.closeAllConnections();
    service?.server.close();
  });
}
