const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("notiFly", {
  testFlight: () => ipcRenderer.send("flight:test"),
  connectCalendar: () => ipcRenderer.invoke("calendar:connect"),
  calendarStatus: () => ipcRenderer.invoke("calendar:status"),
  setReminder: (minutes) => ipcRenderer.send("reminder:set", minutes),
  onFlyby: (callback) => {
    ipcRenderer.on("flyby", (_event, message) => callback(message));
  },
});