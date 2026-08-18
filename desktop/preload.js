"use strict";

// Minimal, sandboxed preload: exposes only app metadata to the renderer.
// The web app detects desktop mode via navigator.userAgent ("Electron/...")
// and does not depend on this bridge for any feature.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("piDesktop", {
  isDesktop: true,
  platform: process.platform,
  info: () => ipcRenderer.invoke("pi-desktop:info"),
  selectDirectory: () => ipcRenderer.invoke("pi-desktop:select-directory"),
  browserCdpInfo: () => ipcRenderer.invoke("pi-desktop:browser-cdp-info"),
  clearBrowserData: (flags) => ipcRenderer.invoke("pi-desktop:clear-browser-data", flags),
  // --- system tray (Settings → General "minimize to tray") ---
  getWindowConfig: () => ipcRenderer.invoke("pi-desktop:get-window-config"),
  setWindowConfig: (config) => ipcRenderer.invoke("pi-desktop:set-window-config", config),
  // --- online updater ---
  checkForUpdates: () => ipcRenderer.invoke("pi-desktop:update-check"),
  downloadUpdate: () => ipcRenderer.invoke("pi-desktop:update-download"),
  installUpdate: () => ipcRenderer.invoke("pi-desktop:update-install"),
  updateState: () => ipcRenderer.invoke("pi-desktop:update-state"),
  onUpdateProgress: (callback) => {
    const subscription = (_event, data) => callback(data);
    ipcRenderer.on("pi-desktop:update-progress", subscription);
    return () => ipcRenderer.removeListener("pi-desktop:update-progress", subscription);
  },
});
