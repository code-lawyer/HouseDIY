const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("desktop", {
  exportPlan: (data) => ipcRenderer.invoke("export-plan", data),
  openAuth: (url) => ipcRenderer.invoke("open-auth", url),
  onHome: (callback) => ipcRenderer.on("go-home", () => callback()),
  onClose: (callback) => ipcRenderer.on("request-close", () => callback()),
  closeReady: () => ipcRenderer.send("close-ready"),
});
