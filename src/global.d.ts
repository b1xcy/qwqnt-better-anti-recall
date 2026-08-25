/// <reference types="vite/client" />

interface IQwQNTPlugin {
  name: string;
  qwqnt?: {
    name?: string;
    icon?: string;
    inject?: {
      main?: string;
      renderer?: string;
      preload?: string;
    };
  };
}

declare namespace RendererEvents {
  const onLogin: (callback: (uid?: string) => void) => void;
  const onSettingsWindowCreated: (callback: () => void) => void;
  const onSettingsWindowCreatedOnce: (callback: () => void) => void;
  const onMessageWindowCreated: (callback: () => void) => void;
  const onMessageWindowCreatedOnce: (callback: () => void) => void;
}

declare namespace PluginSettings {
  interface ICommon {
    readConfig: <T>(id: string, defaultConfig?: T) => T;
    writeConfig: <T>(id: string, newConfig: T) => boolean;
    openPath: (path: string) => void;
    openExternal: (url: string) => void;
  }

  interface IRenderer extends ICommon {
    registerPluginSettings: (packageJson: IQwQNTPlugin) => Promise<HTMLDivElement>;
  }

  const main: ICommon;
  const preload: ICommon;
  const renderer: IRenderer;
}

interface RecalledRecord {
  id: string;
  sender?: string;
  msg: any;
}

interface ShardPageCursor {
  total: number;
  remaining: number;
}

interface RecalledPage {
  records: RecalledRecord[];
  cursor: ShardPageCursor;
  done: boolean;
}

declare global {
  interface Window {
    anti_recall: {
      clearDb: () => Promise<void>;
      getNowConfig: <T = unknown>() => Promise<T>;
      getRecalledPage: (
        cursor?: ShardPageCursor,
        maxShards?: number,
      ) => Promise<RecalledPage>;
      openRecallViewer: () => void;
      getStorageStatus: () => Promise<{
        shardCount: number;
        totalBytes: number;
        recordCount: number;
      }>;
      saveConfig: <T = unknown>(newConfig: T) => Promise<void>;
      testNapcatRkey: (url: string, token: string) => Promise<{
        ok: boolean;
        data?: { group_rkey: string; private_rkey: string; expired_time: number };
        error?: string;
      }>;
      repatchCss: (callback: () => void) => void;
      recallTip: (callback: (_event: unknown, msgId: string) => void) => void;
      recallTipList: (callback: (_event: unknown, msgIds: string[]) => void) => void;
    };
    anti_recall_viewer?: {
      getRecalledPage: (
        cursor?: ShardPageCursor,
        maxShards?: number,
      ) => Promise<RecalledPage>;
    };
  }
}

export {};
