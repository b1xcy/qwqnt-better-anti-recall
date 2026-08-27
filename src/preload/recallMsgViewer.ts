import { contextBridge, ipcRenderer } from 'electron';
import { CH } from '../shared/channels';

contextBridge.exposeInMainWorld('anti_recall_viewer', {
  getRecalledPage: (cursor?: unknown, maxShards?: number) =>
    ipcRenderer.invoke(CH.getRecalledPage, cursor, maxShards),
});
