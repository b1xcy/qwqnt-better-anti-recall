import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('anti_recall_viewer', {
  getRecalledPage: (cursor?: unknown, maxShards?: number) =>
    ipcRenderer.invoke('LiteLoader.anti_recall.getRecalledPage', cursor, maxShards),
});
