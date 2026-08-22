const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gemaclaw", {
  getStatus: () => ipcRenderer.invoke("gemaclaw:get-status"),
  getLogs: () => ipcRenderer.invoke("gemaclaw:get-logs"),
  start: () => ipcRenderer.invoke("gemaclaw:start"),
  stop: () => ipcRenderer.invoke("gemaclaw:stop"),
  restart: () => ipcRenderer.invoke("gemaclaw:restart"),
  pair: (fields) => ipcRenderer.invoke("gemaclaw:pair", fields),
  pendingPrefill: () => ipcRenderer.invoke("gemaclaw:pending-prefill"),
  doctor: () => ipcRenderer.invoke("gemaclaw:doctor"),
  autoGet: () => ipcRenderer.invoke("gemaclaw:auto-get"),
  autoEnable: (enabled) => ipcRenderer.invoke("gemaclaw:auto-enable", enabled),
  autoToggleRoutine: (id) =>
    ipcRenderer.invoke("gemaclaw:auto-toggle-routine", id),
  autoRunNow: (id) => ipcRenderer.invoke("gemaclaw:auto-run-now", id),
  openConfig: () => ipcRenderer.invoke("gemaclaw:open-config"),
  defaultDeviceName: () => ipcRenderer.invoke("gemaclaw:default-device-name"),
  onStatus: (handler) =>
    ipcRenderer.on("gemaclaw-status", (_event, status) => handler(status)),
  onLog: (handler) =>
    ipcRenderer.on("gemaclaw-log", (_event, line) => handler(line)),
  onPrefill: (handler) =>
    ipcRenderer.on("gemaclaw-prefill", (_event, prefill) => handler(prefill)),
  onPrefillAvailable: (handler) =>
    ipcRenderer.on("gemaclaw-prefill-available", () => handler()),
});
