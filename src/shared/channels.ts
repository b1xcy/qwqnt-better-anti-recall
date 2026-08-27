/**
 * IPC 通道名。
 *
 * 原来这些名字以 `LiteLoader.anti_recall.` 开头——那是从
 * LiteLoaderQQNT-Anti-Recall 迁过来时留下的，这个插件跑在 QwQNT 上，
 * 跟 LiteLoader 没有任何关系。
 *
 * 更要紧的是：通道名在主进程和 preload 两边各写一份字面量，改错一边不会
 * 编译报错，只会在运行时静默失效。所以集中定义在这里，两边都从这儿引，
 * 让编译器盯着。
 *
 * 通道名在整个 QwQNT 进程里是全局的，所以带上插件名做前缀，避免和别的
 * 插件撞车。
 */

const NS = "qwqnt-better-anti-recall";

/** 渲染层 → 主进程（invoke/send）。 */
export const CH = {
  clearDb: `${NS}.clearDb`,
  getNowConfig: `${NS}.getNowConfig`,
  getRecalledPage: `${NS}.getRecalledPage`,
  openRecallViewer: `${NS}.openRecallViewer`,
  getStorageStatus: `${NS}.getStorageStatus`,
  saveConfig: `${NS}.saveConfig`,
  testNapcatRkey: `${NS}.testNapcatRkey`,
} as const;

/** 主进程 → 渲染层（webContents.send）。 */
export const CH_MAIN = {
  repatchCss: `${NS}.mainWindow.repatchCss`,
  recallTip: `${NS}.mainWindow.recallTip`,
  recallTipList: `${NS}.mainWindow.recallTipList`,
} as const;
