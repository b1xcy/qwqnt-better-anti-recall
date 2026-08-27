import { contextBridge, ipcRenderer } from 'electron';
import { CH, CH_MAIN } from '../shared/channels';

contextBridge.exposeInMainWorld('anti_recall', {
  clearDb: () => ipcRenderer.invoke(CH.clearDb),
  getNowConfig: () => ipcRenderer.invoke(CH.getNowConfig),
  getRecalledPage: (cursor?: unknown, maxShards?: number) =>
    ipcRenderer.invoke(CH.getRecalledPage, cursor, maxShards),
  openRecallViewer: () => ipcRenderer.send(CH.openRecallViewer),
  getStorageStatus: () => ipcRenderer.invoke(CH.getStorageStatus),
  saveConfig: (newConfig: unknown) => ipcRenderer.invoke(CH.saveConfig, newConfig),
  testNapcatRkey: (url: string, token: string) =>
    ipcRenderer.invoke(CH.testNapcatRkey, url, token),

  repatchCss: (callback: () => void) => ipcRenderer.on(CH_MAIN.repatchCss, callback),
  recallTip: (callback: (_event: unknown, msgId: string) => void) =>
    ipcRenderer.on(CH_MAIN.recallTip, callback),
  recallTipList: (callback: (_event: unknown, msgIds: string[]) => void) =>
    ipcRenderer.on(CH_MAIN.recallTipList, callback),
});
