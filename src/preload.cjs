const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("desktop", {
  exportPlan: (data) => ipcRenderer.invoke("export-plan", data),
  onHome: (callback) => ipcRenderer.on("go-home", () => callback()),
  onClose: (callback) => ipcRenderer.on("request-close", () => callback()),
  closeReady: () => ipcRenderer.send("close-ready"),
});
