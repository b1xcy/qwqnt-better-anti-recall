import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('anti_recall_viewer', {
  getRecalledMessages: () =>
    ipcRenderer.invoke('LiteLoader.anti_recall.getRecalledMessages'),
});
