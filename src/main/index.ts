import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { BrowserWindow, app, dialog, ipcMain, net } from "electron";
import { JsonShardStore, type ShardPageCursor } from "./jsonShardStore";
import {
  annotateForViewer,
  normalizeForStorage,
  restoreForKernel,
} from "./videoMedia";
import { CH, CH_MAIN } from "../shared/channels";
import { createVideoPreloader } from "./videoPreloader";

interface AntiRecallConfig {
  mainColor: string;
  saveDb: boolean;
  saveImagesToDataDir: boolean;
  enableShadow: boolean;
  enableTip: boolean;
  isAntiRecallSelfMsg: boolean;
  enablePeriodicCleanup: boolean;
  maxMsgSaveLimit: number;
  deleteMsgCountPerTime: number;
  enableNapcatRkey: boolean;
  napcatRkeyUrl: string;
  napcatRkeyToken: string;
  /** 从 SnowLuma 获取 RKey（NapCat 之外的第二来源） */
  enableSnowlumaRkey: boolean;
  snowlumaRkeyUrl: string;
  snowlumaPassword: string;
  /** 留空则自动从 /api/qq-list 取第一个账号 */
  snowlumaUin: string;
  /** 新视频到达时自动预下载（防撤回未点开的视频） */
  enableVideoPreDownload: boolean;
  /** 单文件大小上限（MB），超过不预下载；0 表示不限制 */
  videoPreDownloadMaxSizeMB: number;
}

interface StorageStatus {
  shardCount: number;
  totalBytes: number;
  recordCount: number;
}

interface RKeyData {
  group_rkey: string;
  private_rkey: string;
  expired_time: number;
}

function normalizeRkey(raw: string | undefined | null): string {
  if (!raw) return "";
  let v = raw.trim();
  v = v.replace(/^&?rkey=/i, "");
  v = v.replace(/^&/, "");
  return v;
}

async function netFetch(url: string, opts?: RequestInit): Promise<Response> {
  // Electron net.fetch uses Chromium's network stack (same as the browser).
  // Plain Node fetch (undici) may fail TLS/ALPN against some servers.
  if (net?.fetch) return net.fetch(url, opts);
  return fetch(url, opts);
}

class RKeyManager {
  private snowlumaSource: { url: string; password: string; uin: string } | null =
    null;
  private snowlumaCredential = "";
  private snowlumaCredentialExpire = 0;
  private cachePath: string | null = null;
  private rkeyData: RKeyData = {
    group_rkey: "",
    private_rkey: "",
    expired_time: 0,
  };
  private napcatSource: { url: string; token: string } | null = null;
  private napcatCredential: string | null = null;
  private napcatCredentialExpire: number = 0;
  private readonly NAPCAT_CREDENTIAL_TTL = 3600; // WebUI Credential 有效期 1 小时

  constructor(opts?: { cachePath?: string }) {
    if (opts?.cachePath) this.cachePath = opts.cachePath;
    this.loadCache();
  }

  setSnowlumaSource(url: string, password: string, uin: string): void {
    const trimmed = url.trim().replace(/\/+$/, "");
    this.snowlumaSource =
      trimmed ? { url: trimmed, password, uin: uin.trim() } : null;
    if (this.snowlumaSource) {
      debugLog("[RKeyManager] snowluma source set:", this.snowlumaSource.url);
      // 源变了，旧凭据作废
      this.snowlumaCredential = "";
      this.snowlumaCredentialExpire = 0;
    } else {
      debugLog("[RKeyManager] snowluma source disabled");
    }
  }

  // 登录 SnowLuma WebUI，换取 Bearer Token
  private async snowlumaLogin(): Promise<string> {
    const src = this.snowlumaSource;
    if (!src) throw new Error("snowluma source not configured");
    const res = await netFetch(`${src.url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: src.password }),
    });
    if (!res.ok)
      throw new Error(`snowluma login http ${res.status} ${res.statusText}`);
    const body = (await res.json()) as any;
    // 响应形状未公开文档化，按常见位置取 token
    const token =
      body?.data?.token ??
      body?.data?.Credential ??
      body?.data?.credential ??
      body?.token ??
      body?.credential ??
      body?.Authorization ??
      "";
    if (typeof token !== "string" || !token) {
      throw new Error(
        `snowluma login failed: ${safeStringify(body).slice(0, 300)}`,
      );
    }
    this.snowlumaCredential = token;
    this.snowlumaCredentialExpire = Date.now() / 1000 + 3600;
    debugLog("[RKeyManager] snowluma login ok");
    return token;
  }

  private async snowlumaAuthorizedFetch(
    path: string,
    init: RequestInit,
  ): Promise<any> {
    const src = this.snowlumaSource;
    if (!src) throw new Error("snowluma source not configured");
    let credential = this.snowlumaCredential;
    if (
      !credential ||
      Date.now() / 1000 >= this.snowlumaCredentialExpire
    ) {
      credential = await this.snowlumaLogin();
    }
    const doFetch = (cred: string) =>
      netFetch(`${src.url}${path}`, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          Authorization: `Bearer ${cred}`,
        },
      });
    let res = await doFetch(credential);
    // 凭据失效则重登一次
    if (res.status === 401 || res.status === 403) {
      this.snowlumaCredential = "";
      credential = await this.snowlumaLogin();
      res = await doFetch(credential);
    }
    if (!res.ok)
      throw new Error(
        `snowluma ${path} http ${res.status} ${res.statusText}`,
      );
    return (await res.json()) as any;
  }

  // 从任意 JSON 里递归收集 uin（qq-list 的响应形状未文档化）
  private collectUins(body: any, out: string[] = []): string[] {
    if (out.length > 20) return out;
    if (typeof body === "string") {
      if (/^\d{5,12}$/.test(body)) out.push(body);
      return out;
    }
    if (Array.isArray(body)) {
      for (const x of body) this.collectUins(x, out);
      return out;
    }
    if (body && typeof body === "object") {
      for (const k of Object.keys(body)) {
        if (/^(uin|qq|userId|user_id)$/i.test(k)) {
          const v = body[k];
          if (typeof v === "string" || typeof v === "number") {
            out.push(String(v));
            continue;
          }
        }
        this.collectUins(body[k], out);
      }
    }
    return out;
  }

  // 用给定地址/密码/账号测试 SnowLuma 源（不改变实例状态）
  async testSnowlumaSource(
    url: string,
    password: string,
    uin: string,
  ): Promise<{ ok: boolean; data?: RKeyData; error?: string }> {
    const prevSource = this.snowlumaSource;
    const prevCredential = this.snowlumaCredential;
    const prevCredentialExpire = this.snowlumaCredentialExpire;
    this.snowlumaSource =
      url.trim().replace(/\/+$/, "")
        ? { url: url.trim().replace(/\/+$/, ""), password, uin: uin.trim() }
        : null;
    this.snowlumaCredential = "";
    this.snowlumaCredentialExpire = 0;
    try {
      const data = await this.fetchSnowlumaRkey();
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    } finally {
      this.snowlumaSource = prevSource;
      this.snowlumaCredential = prevCredential;
      this.snowlumaCredentialExpire = prevCredentialExpire;
    }
  }

  private async fetchSnowlumaRkey(): Promise<RKeyData> {
    const src = this.snowlumaSource;
    if (!src) throw new Error("snowluma source not configured");

    // 拿 uin：配置里填了就用，否则从 qq-list 取第一个
    let uin = src.uin;
    if (!uin) {
      const listBody = await this.snowlumaAuthorizedFetch("/api/qq-list", {
        method: "GET",
      });
      const uins = this.collectUins(listBody);
      if (uins.length === 0) {
        throw new Error(
          `snowluma qq-list 没有可用账号: ${safeStringify(listBody).slice(0, 300)}`,
        );
      }
      uin = uins[0];
    }

    const body = await this.snowlumaAuthorizedFetch("/api/debug/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uin,
        action: "get_rkey_server",
        params: {},
      }),
    });

    // 响应形状防御性解析：
    //  A. { status, data: [ {rkey, type, ttl, time} ] }（type 10=private 20=group）
    //  B. { data: { group_rkey, private_rkey, expired_time } }
    //  C. 顶层直接是 {group_rkey, private_rkey}
    const list = Array.isArray(body?.data)
      ? body.data
      : Array.isArray(body?.data?.data)
        ? body.data.data
        : null;
    if (list) {
      const privateItem = list.find((i: any) => i?.type === 10);
      const groupItem = list.find((i: any) => i?.type === 20);
      const anyItem = list[0];
      const expired = Math.min(
        ...list.map((i: any) => Number(i?.time ?? 0) + Number(i?.ttl ?? 0)),
      );
      const groupRkey = normalizeRkey(
        groupItem?.rkey ?? privateItem?.rkey ?? anyItem?.rkey ?? "",
      );
      const privateRkey = normalizeRkey(
        privateItem?.rkey ?? groupItem?.rkey ?? anyItem?.rkey ?? "",
      );
      if (!groupRkey && !privateRkey) {
        throw new Error(`snowluma rkey 列表为空: ${safeStringify(body).slice(0, 300)}`);
      }
      return { group_rkey: groupRkey, private_rkey: privateRkey, expired_time: expired };
    }
    const d = body?.data ?? body;
    const groupRkey = normalizeRkey(d?.group_rkey ?? d?.groupRkey ?? "");
    const privateRkey = normalizeRkey(d?.private_rkey ?? d?.privateRkey ?? "");
    if (!groupRkey && !privateRkey) {
      throw new Error(
        `snowluma rkey 响应无法解析: ${safeStringify(body).slice(0, 300)}`,
      );
    }
    return {
      group_rkey: groupRkey,
      private_rkey: privateRkey,
      expired_time: Number(d?.expired_time ?? 0),
    };
  }

  setNapcatSource(url: string, token: string): void {
    const trimmed = url.trim().replace(/\/+$/, "");
    this.napcatSource = trimmed && token ? { url: trimmed, token } : null;
    if (this.napcatSource) {
      debugLog("[RKeyManager] napcat source set:", this.napcatSource.url);
    } else {
      debugLog("[RKeyManager] napcat source disabled");
    }
  }

  // 登录 NapCat WebUI,换取 1 小时有效的 Credential
  private async napcatLogin(): Promise<string> {
    const src = this.napcatSource;
    if (!src) throw new Error("napcat source not configured");
    const hash = crypto
      .createHash("sha256")
      .update(src.token + ".napcat")
      .digest()
      .toString("hex");
    const res = await netFetch(`${src.url}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hash }),
    });
    if (!res.ok)
      throw new Error(`napcat login http ${res.status} ${res.statusText}`);
    const body = (await res.json()) as any;
    const credential = body?.data?.Credential;
    if (!credential)
      throw new Error(`napcat login failed: ${safeStringify(body)}`);
    this.napcatCredential = credential;
    this.napcatCredentialExpire =
      Date.now() / 1000 + this.NAPCAT_CREDENTIAL_TTL;
    debugLog("[RKeyManager] napcat login ok");
    return credential;
  }

  private async fetchNapcatRkey(): Promise<RKeyData> {
    const src = this.napcatSource;
    if (!src) throw new Error("napcat source not configured");

    // Credential 失效时重新登录
    let credential = this.napcatCredential;
    if (!credential || Date.now() / 1000 >= this.napcatCredentialExpire) {
      credential = await this.napcatLogin();
    }

    const res = await netFetch(`${src.url}/api/Debug/call`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${credential}`,
      },
      body: JSON.stringify({ action: "nc_get_rkey", params: {} }),
    });
    if (!res.ok)
      throw new Error(`napcat call http ${res.status} ${res.statusText}`);
    const body = (await res.json()) as any;

    // 实测结构: { code, data: { status, retcode, data: [{rkey, ttl, time, type}], ... }, message }
    // rkeyList 在 body.data.data;防御性兼容不同包装
    const ob11 = body?.data;
    let list = ob11?.data;
    if (!Array.isArray(list)) list = body?.data;
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error(
        `napcat nc_get_rkey 返回中没有 rkeyList: ${safeStringify(body)}`,
      );
    }

    const privateItem = list.find((i: any) => i.type === 10);
    const groupItem = list.find((i: any) => i.type === 20);
    if (!privateItem?.rkey || !groupItem?.rkey) {
      throw new Error(`napcat rkey 缺少 private/group: ${safeStringify(list)}`);
    }

    const expired = Math.min(
      Number(privateItem.time) + Number(privateItem.ttl),
      Number(groupItem.time) + Number(groupItem.ttl),
    );
    return {
      group_rkey: normalizeRkey(groupItem.rkey),
      private_rkey: normalizeRkey(privateItem.rkey),
      expired_time: expired,
    };
  }

  // 用给定地址/token 测试 NapCat 源(不改变实例状态)
  async testNapcatSource(
    url: string,
    token: string,
  ): Promise<{ ok: boolean; data?: RKeyData; error?: string }> {
    const trimmed = url.trim().replace(/\/+$/, "");
    if (!trimmed) return { ok: false, error: "NapCat 地址不能为空" };
    if (!token) return { ok: false, error: "WebUI Token 不能为空" };
    const prevSource = this.napcatSource;
    const prevCredential = this.napcatCredential;
    const prevCredentialExpire = this.napcatCredentialExpire;
    this.napcatSource = { url: trimmed, token };
    this.napcatCredential = null;
    this.napcatCredentialExpire = 0;
    try {
      const data = await this.fetchNapcatRkey();
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    } finally {
      this.napcatSource = prevSource;
      this.napcatCredential = prevCredential;
      this.napcatCredentialExpire = prevCredentialExpire;
    }
  }

  private loadCache(): void {
    if (!this.cachePath) return;
    try {
      if (fs.existsSync(this.cachePath)) {
        const d = JSON.parse(
          fs.readFileSync(this.cachePath, "utf-8"),
        ) as Partial<RKeyData>;
        if (d?.group_rkey || d?.private_rkey) {
          this.rkeyData = {
            group_rkey: d.group_rkey ?? "",
            private_rkey: d.private_rkey ?? "",
            expired_time: d.expired_time ?? 0,
          };
          debugLog("[RKeyManager] loaded rkey cache from disk.");
        }
      }
    } catch (e) {
      debugLog("[RKeyManager] loadCache failed:", e);
    }
  }

  private saveCache(): void {
    if (!this.cachePath) return;
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      fs.writeFileSync(this.cachePath, JSON.stringify(this.rkeyData), "utf-8");
    } catch (e) {
      debugLog("[RKeyManager] saveCache failed:", e);
    }
  }

  // Feed a valid rkey observed in QQ's own network traffic.
  capture(groupRkey: string, privateRkey: string, expiredTime = 0): void {
    let changed = false;
    if (groupRkey && groupRkey !== this.rkeyData.group_rkey) {
      this.rkeyData.group_rkey = groupRkey;
      changed = true;
    }
    if (privateRkey && privateRkey !== this.rkeyData.private_rkey) {
      this.rkeyData.private_rkey = privateRkey;
      changed = true;
    }
    if (expiredTime && this.rkeyData.expired_time !== expiredTime) {
      this.rkeyData.expired_time = expiredTime;
      changed = true;
    }
    if (changed) this.saveCache();
  }

  async getRkey(force = false): Promise<RKeyData> {
    if (force || this.isExpired()) {
      try {
        await this.refreshRkey();
      } catch (e) {
        debugLog("[RKeyManager] get rkey failed, keep current cache:", e);
      }
    }
    return this.rkeyData;
  }

  private isExpired(): boolean {
    if (this.rkeyData.expired_time <= 0)
      return !this.rkeyData.group_rkey && !this.rkeyData.private_rkey;
    return Date.now() / 1000 > this.rkeyData.expired_time;
  }

  private async refreshRkey(): Promise<void> {
    // 优先从 NapCat WebUI 获取;失败则 fallback 到服务器
    if (this.napcatSource) {
      try {
        const data = await this.fetchNapcatRkey();
        this.rkeyData = { ...data };
        this.saveCache();
        debugLog(
          "[RKeyManager] refreshed rkey from napcat:",
          this.napcatSource.url,
        );
        return;
      } catch (e) {
        debugLog("[RKeyManager] napcat source failed:", e);
      }
    }
    // 其次从 SnowLuma 获取
    if (this.snowlumaSource) {
      try {
        const data = await this.fetchSnowlumaRkey();
        this.rkeyData = { ...data };
        this.saveCache();
        debugLog(
          "[RKeyManager] refreshed rkey from snowluma:",
          this.snowlumaSource.url,
        );
        return;
      } catch (e) {
        debugLog("[RKeyManager] snowluma source failed:", e);
      }
    }
    throw new Error("all rkey sources failed");
  }
}

const LEGACY_IMAGE_ORIGIN = "https://gchat.qpic.cn";
const NT_IMAGE_ORIGIN = "https://multimedia.nt.qq.com.cn";

class ImageDownloader {
  private rkeyManager = new RKeyManager({
    cachePath: rkeyCachePath,
  });
  private saveToDataDir: string | null = null;

  constructor(opts?: { saveToDataDir?: string }) {
    if (opts?.saveToDataDir)
      this.saveToDataDir = path.join(opts.saveToDataDir, "images");
  }

  setSaveToDataDir(dataDir: string | null): void {
    this.saveToDataDir = dataDir ? path.join(dataDir, "images") : null;
  }

  setNapcatSource(url: string, token: string): void {
    this.rkeyManager.setNapcatSource(url, token);
  }

  setSnowlumaSource(url: string, password: string, uin: string): void {
    this.rkeyManager.setSnowlumaSource(url, password, uin);
  }

  async testNapcatRkey(
    url: string,
    token: string,
  ): Promise<{ ok: boolean; data?: RKeyData; error?: string }> {
    return await this.rkeyManager.testNapcatSource(url, token);
  }

  async testSnowlumaRkey(
    url: string,
    password: string,
    uin: string,
  ): Promise<{ ok: boolean; data?: RKeyData; error?: string }> {
    return await this.rkeyManager.testSnowlumaSource(url, password, uin);
  }

  captureRkey(groupRkey: string, privateRkey: string): void {
    this.rkeyManager.capture(
      normalizeRkey(groupRkey),
      normalizeRkey(privateRkey),
    );
  }

  async getImageUrl(picElement: any, forceRkey = false): Promise<string> {
    if (!picElement) return "";
    const originImageUrl: string | undefined = picElement.originImageUrl;
    const md5HexStr: string | undefined = picElement.md5HexStr;

    if (originImageUrl) {
      const url = new URL(LEGACY_IMAGE_ORIGIN + originImageUrl);
      const appid = url.searchParams.get("appid");

      if (appid && ["1406", "1407"].includes(appid)) {
        let rkey = url.searchParams.get("rkey");
        if (!rkey) {
          const rkeys = await this.rkeyManager.getRkey(forceRkey);
          rkey =
            appid === "1406"
              ? normalizeRkey(rkeys.private_rkey)
              : normalizeRkey(rkeys.group_rkey);
        }

        const target = new URL(NT_IMAGE_ORIGIN + originImageUrl);
        if (rkey) target.searchParams.set("rkey", rkey);
        return target.toString();
      }

      return LEGACY_IMAGE_ORIGIN + originImageUrl;
    }

    if (md5HexStr)
      return `${LEGACY_IMAGE_ORIGIN}/gchatpic_new/0/0-0-${md5HexStr.toUpperCase()}/0`;

    this.output("Pic url get error:", picElement);
    return "";
  }

  async downloadPic(msgRecord: any): Promise<void> {
    debugLog(
      "[downloadPic] called. msgId=",
      msgRecord?.msgId,
      "elementsCount=",
      msgRecord?.elements?.length,
    );
    if (!Array.isArray(msgRecord?.elements)) {
      debugLog("[downloadPic] no elements, abort.");
      return;
    }

    const msgIdStr = String(msgRecord?.msgId ?? "");

    for (let idx = 0; idx < msgRecord.elements.length; idx++) {
      const el = msgRecord.elements[idx];
      if (!el?.picElement) {
        debugLog("[downloadPic] element[", idx, "] has no picElement, skip.");
        continue;
      }

      const pic = el.picElement;
      const sourcePath: string | undefined = pic.sourcePath;
      debugLog(
        "[downloadPic] element[",
        idx,
        "] picElement keys=",
        Object.keys(pic).join(","),
        "sourcePath=",
        sourcePath,
      );
      if (!sourcePath) {
        debugLog(
          "[downloadPic] sourcePath missing, cannot download. pic=",
          safeStringify(pic),
        );
        continue;
      }

      const thumbMap = new Map<number, string>([
        [0, sourcePath],
        [198, sourcePath],
        [720, sourcePath],
      ]);

      let url = await this.getImageUrl(pic);
      this.output(
        "Download lost pic(s)... url=",
        url,
        "msgId=",
        msgIdStr,
        "to=",
        sourcePath,
      );
      debugLog(
        "[downloadPic] resolved url=",
        url,
        "msgId=",
        msgIdStr,
        "to=",
        sourcePath,
      );

      let tooSmall = false;
      try {
        tooSmall = fs.statSync(sourcePath).size <= 100;
        debugLog(
          "[downloadPic] sourcePath exists, size=",
          fs.statSync(sourcePath).size,
        );
      } catch (e) {
        debugLog("[downloadPic] statSync(sourcePath) failed: ", e);
      }

      if (!fs.existsSync(sourcePath) || tooSmall) {
        this.output("Download pic:", url, " to ", sourcePath);
        debugLog(
          "[downloadPic] need download. exists=",
          fs.existsSync(sourcePath),
          "tooSmall=",
          tooSmall,
        );
        let data = await this.request(url);
        debugLog("[downloadPic] download finished. bytes=", data?.length);
        let parsed: any = null;
        try {
          parsed = JSON.parse(data.toString());
        } catch {
          parsed = null;
        }

        const isRkeyError =
          parsed && parsed?.retmsg && String(parsed.retmsg).includes("rkey");
        if (isRkeyError) {
          debugLog(
            "[downloadPic] got invalid rkey, scrape renderer + force-refresh rkey and retry once. msg=",
            safeStringify(parsed),
          );
          await scrapeAllWindowsForRkey();
          url = await this.getImageUrl(pic, true);
          debugLog("[downloadPic] retry with url=", url);
          data = await this.request(url);
          debugLog(
            "[downloadPic] retry download finished. bytes=",
            data?.length,
          );
          try {
            parsed = JSON.parse(data.toString());
          } catch {
            parsed = null;
          }
        }

        if (parsed) {
          this.output("Picture already expired.", url, sourcePath);
          debugLog(
            "[downloadPic] downloaded body looks like JSON (expired). bytes=",
            data?.length,
            "head=",
            data.toString("utf8").slice(0, 200),
          );
        } else {
          fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
          fs.writeFileSync(sourcePath, data);
          debugLog("[downloadPic] saved to sourcePath. bytes=", data?.length);
          await this.copyToDataDir(data, msgIdStr, sourcePath, idx);
        }
      } else {
        this.output("Pic already existed, skip.", sourcePath);
        debugLog("[downloadPic] pic already exists, skip download.");
        if (this.saveToDataDir) {
          await this.copyToDataDir(
            fs.readFileSync(sourcePath),
            msgIdStr,
            sourcePath,
            idx,
          );
        }
      }

      if (
        pic?.thumbPath &&
        (Array.isArray(pic.thumbPath) || pic.thumbPath instanceof Object)
      ) {
        pic.thumbPath = thumbMap;
      }
    }
  }

  private async copyToDataDir(
    data: Buffer,
    msgId: string,
    sourcePath: string,
    idx: number,
  ): Promise<void> {
    debugLog(
      "[copyToDataDir] enter. msgId=",
      msgId,
      "sourcePath=",
      sourcePath,
      "saveToDataDir=",
      this.saveToDataDir,
    );
    if (!this.saveToDataDir) {
      debugLog("[copyToDataDir] saveToDataDir disabled, skip.");
      return;
    }
    try {
      fs.mkdirSync(this.saveToDataDir, { recursive: true });
      const ext = path.extname(sourcePath) || ".jpg";
      const base = path
        .basename(sourcePath, ext)
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .slice(0, 32);
      const out = path.join(
        this.saveToDataDir,
        `${msgId}_${idx}_${base}${ext}`,
      );
      if (!fs.existsSync(out)) {
        fs.writeFileSync(out, data);
        this.output("Saved recalled image to data dir:", out);
        debugLog(
          "[copyToDataDir] saved to data dir. bytes=",
          data?.length,
          "out=",
          out,
        );
      } else {
        debugLog("[copyToDataDir] target already exists, skip. out=", out);
      }
    } catch (e) {
      this.output("Failed to copy image to data dir:", e);
      debugLog("[copyToDataDir] FAILED:", e);
    }
  }

  private async request(url: string): Promise<Buffer> {
    debugLog("[request] enter. url=", url);
    return await new Promise((resolve, reject) => {
      const client = url.startsWith("https") ? https : http;
      const req = client.get(url);

      req.on("error", (err) => {
        this.output("Download error", err);
        debugLog("[request] request error:", err);
        reject(err);
      });

      req.on("response", (res) => {
        debugLog(
          "[request] response. statusCode=",
          res.statusCode,
          "location=",
          res.headers.location,
        );
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode <= 399 &&
          res.headers.location
        ) {
          debugLog("[request] redirect to:", res.headers.location);
          resolve(this.request(res.headers.location));
          return;
        }

        const chunks: Buffer[] = [];
        res.on("error", (err) => {
          this.output("Download error", err);
          debugLog("[request] response error:", err);
          reject(err);
        });
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () => {
          debugLog(
            "[request] response end. totalChunks=",
            chunks.length,
            "bytes=",
            Buffer.concat(chunks).length,
          );
          resolve(Buffer.concat(chunks));
        });
      });
    });
  }

  private output(...args: unknown[]): void {
    console.log("\x1B[32m%s\x1B[0m", "Anti-Recall:", ...args);
  }
}

console.log(
  "%c[Anti-Recall]",
  "background:#ffdc00;color:#000000D9;padding:2px 4px;border-radius:4px;",
  "Main loaded",
);

const PLUGIN_ID = "qwqnt-better-anti-recall";

function getConfigDir(): string {
  const configs = (globalThis as any)?.qwqnt?.framework?.paths?.configs as
    | string
    | undefined;
  return configs
    ? path.join(configs, PLUGIN_ID)
    : path.join(app.getPath("userData"), "qwqnt-storage", "config", PLUGIN_ID);
}

function getDataDir(): string {
  const data = (globalThis as any)?.qwqnt?.framework?.paths?.data as
    | string
    | undefined;
  return data
    ? path.join(data, PLUGIN_ID)
    : path.join(app.getPath("userData"), "qwqnt-storage", "data", PLUGIN_ID);
}

let configPath = "";
const configDir = getConfigDir();
const dataDir = getDataDir();
const imagesDir = path.join(dataDir, "images");
const debugLogPath = path.join(dataDir, "anti-recall-debug.log");

function debugLog(...args: unknown[]): void {
  try {
    const ts = new Date().toISOString();
    const line = `${ts} ${args.map((a) => (a instanceof Error ? (a.stack ?? String(a)) : typeof a === "string" ? a : safeStringify(a))).join(" ")}\n`;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(debugLogPath, line, "utf-8");
  } catch {
    // ignore
  }
}

function safeStringify(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    if (s === undefined) return String(value);
    return s.length > 2000 ? s.slice(0, 2000) + "..." : s;
  } catch {
    return String(value);
  }
}

const jsonDbPath = path.join(dataDir, "qq-recalled-db.json");
const shardDir = path.join(dataDir, "recalled");
const legacyShardDir = path.join(dataDir, "qq-recalled-db");
const rkeyCachePath = path.join(dataDir, "rkey-cache.json");

const imageDownloader = new ImageDownloader();


const DEFAULT_CONFIG: AntiRecallConfig = {
  mainColor: "#ff6d6d",
  saveDb: false,
  saveImagesToDataDir: false,
  enableShadow: true,
  enableTip: true,
  isAntiRecallSelfMsg: false,
  enablePeriodicCleanup: true,
  maxMsgSaveLimit: 10_000,
  deleteMsgCountPerTime: 500,
  enableNapcatRkey: false,
  napcatRkeyUrl: "",
  napcatRkeyToken: "",
  enableSnowlumaRkey: false,
  snowlumaRkeyUrl: "http://127.0.0.1:5099",
  snowlumaPassword: "",
  snowlumaUin: "",
  enableVideoPreDownload: true,
  videoPreDownloadMaxSizeMB: 50,
};

let config: AntiRecallConfig = { ...DEFAULT_CONFIG };

/**
 * 视频预下载器：新视频到达时替用户提前触发内核下载。
 * 通道与信封形状见 videoPreloader.ts 头注释。
 */
const videoPreloader = createVideoPreloader({
  debugLog,
  isEnabled: () => config.enableVideoPreDownload === true,
  maxBytes: () => {
    // 0 表示不限制大小
    const mb = Math.floor(config.videoPreDownloadMaxSizeMB ?? 50);
    return mb <= 0 ? 0 : mb * 1024 * 1024;
  },
});

const jsonStore = new JsonShardStore({
  dir: shardDir,
  legacyFile: jsonDbPath,
  legacyDir: legacyShardDir,
  log: debugLog,
});

function writeDefaultConfig(): void {
  fs.writeFileSync(
    configPath,
    JSON.stringify(DEFAULT_CONFIG, null, 2),
    "utf-8",
  );
}

/**
 * 只保留已知字段并补齐缺省值。
 *
 * 顺带把废弃的键（比如 dbStorageType）从用户配置里剔掉——本版本起
 * 存储后端只有分片 JSON 一种，留着那个键会让人以为还能切。
 */
function normalizeConfig(raw: Partial<AntiRecallConfig> | null): AntiRecallConfig {
  const out = { ...DEFAULT_CONFIG };
  if (!raw || typeof raw !== "object") return out;

  for (const key of Object.keys(DEFAULT_CONFIG) as Array<keyof AntiRecallConfig>) {
    const v = raw[key];
    if (v == null) continue;
    if (typeof v !== typeof DEFAULT_CONFIG[key]) continue;
    (out as any)[key] = v;
  }

  if (!(out.maxMsgSaveLimit > 0)) out.maxMsgSaveLimit = DEFAULT_CONFIG.maxMsgSaveLimit;
  if (!(out.deleteMsgCountPerTime > 0))
    out.deleteMsgCountPerTime = DEFAULT_CONFIG.deleteMsgCountPerTime;
  return out;
  if (!(out.videoPreDownloadMaxSizeMB >= 0))
    out.videoPreDownloadMaxSizeMB = DEFAULT_CONFIG.videoPreDownloadMaxSizeMB;
}

function readConfig(): AntiRecallConfig {
  if (!fs.existsSync(configPath)) {
    writeDefaultConfig();
    return { ...DEFAULT_CONFIG };
  }
  try {
    return normalizeConfig(
      JSON.parse(fs.readFileSync(configPath, "utf-8")) as AntiRecallConfig,
    );
  } catch (e) {
    debugLog("[config] 解析失败，回退默认值:", e);
    return { ...DEFAULT_CONFIG };
  }
}

function updateImageSaveDir(): void {
  imageDownloader.setSaveToDataDir(config.saveImagesToDataDir ? dataDir : null);
}


async function saveToDb(record: any): Promise<void> {
  if (!config.saveDb) return;
  // 落盘前把 videoElement.thumbPath 从 Map 换成普通对象。
  // Map 过 JSON.stringify 会变成 {}，那正是「重启后封面全丢」的根因。
  // 用返回的副本存盘——record 本身是 msgFlowCache 里的内核原件，不能动。
  await jsonStore.put(String(record.id), normalizeForStorage(record));
}

async function readFromDb(id: string): Promise<any | null> {
  if (!config.saveDb) return null;
  return await jsonStore.get(id);
}

const msgFlowCache: Array<{ id: string; sender?: string; msg: any }> = [];
const recalledCache: Array<{ id: string; sender?: string; msg: any }> = [];
let recallViewerWindow: BrowserWindow | null = null;

const patchedWindows: BrowserWindow[] = [];

function broadcast(channel: string): void {
  for (const win of patchedWindows) {
    if (win.isDestroyed()) continue;
    win.webContents.send(channel);
  }
}

function captureRkeyFromUrls(urls: string[]): void {
  for (const url of urls ?? []) {
    try {
      const u = new URL(url);
      const rkey = u.searchParams.get("rkey");
      const appid = u.searchParams.get("appid");
      if (rkey) {
        const groupRkey = appid === "1407" ? rkey : "";
        const privateRkey = appid === "1406" ? rkey : "";
        imageDownloader.captureRkey(groupRkey, privateRkey);
        debugLog("[rkey-capture] observed rkey. appid=", appid, "url=", url);
      }
    } catch {
      // ignore
    }
  }
}

async function scrapeAllWindowsForRkey(): Promise<void> {
  for (const win of patchedWindows) {
    try {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      const urls: string[] = await win.webContents.executeJavaScript(
        `(() => {
          const out = new Set();
          const add = (u) => {
            if (typeof u === 'string' && (u.includes('multimedia.nt.qq.com.cn') || u.includes('gchat.qpic.cn'))) out.add(u);
          };
          try {
            performance.getEntriesByType('resource').forEach((e) => add(e.name));
          } catch {}
          try {
            document.querySelectorAll('img, video, source, [src], [srcset]').forEach((el) => {
              if (el.currentSrc) add(el.currentSrc);
              if (el.src) add(el.src);
              if (el.getAttribute && el.getAttribute('src')) add(el.getAttribute('src'));
            });
          } catch {}
          return Array.from(out).slice(0, 200);
        })()`,
      );
      captureRkeyFromUrls(urls);
    } catch {
      // ignore
    }
  }
}

function patchWindow(win: BrowserWindow): void {
  if (!win?.webContents || win.isDestroyed()) return;
  const wc: any = win.webContents;
  if (wc.__antiRecallPatched) return;
  wc.__antiRecallPatched = true;
  patchedWindows.push(win);

  try {
    const ses = win.webContents.session as any;
    if (ses && !ses.__antiRecallRkeyHook) {
      ses.__antiRecallRkeyHook = true;
      // 注意：每个 session 只能注册一个 onBeforeRequest，后注册的会顶掉前面的。
      //
      // 实测（QQ 新版 AIO）：内核读本地媒体走的是 appimg:// 协议，视频下载也
      // 不经 Electron 网络栈——放宽到 <all_urls> 观察过一轮，14 个 host 里没有
      // 任何 CDN。所以这个 hook 在当前版本上大概率抓不到 rkey，留着是为了兼容
      // 那些确实走 HTTP 的版本，真正可靠的来源是设置里的 NapCat RKey。
      ses.webRequest.onBeforeRequest(
        {
          urls: [
            "https://multimedia.nt.qq.com.cn/*",
            "https://gchat.qpic.cn/*",
          ],
        },
        (details: any, callback: any) => {
          captureRkeyFromUrls([details.url]);
          if (typeof callback === "function") callback({});
        },
      );
    }
  } catch (e) {
    debugLog("[rkey-capture] setup failed:", e);
  }

  // Scrape valid rkey from the renderer's loaded image URLs (QQ kernel bypasses webRequest).
  const doScrape = (): void => {
    void scrapeAllWindowsForRkey();
  };
  wc.on("did-finish-load", doScrape);
  const scrapeTimer = setInterval(doScrape, 10_000);
  wc.once("destroyed", () => {
    clearInterval(scrapeTimer);
    const i = patchedWindows.indexOf(win);
    if (i !== -1) patchedWindows.splice(i, 1);
  });

  // __qqntim_original_object 是 qwqnt-ipc-interceptor 挂上来的，名字带 qqntim
  // 是它的历史，不是本插件的遗留——**不要**改名，那是外部约定。
  const originalSend: any =
    wc.__qqntim_original_object?.send ?? wc.send.bind(wc);

  const wrappedSend = async (channel: string, ...args: any[]): Promise<any> => {
    try {
      if (args.length >= 2) {
        // msgList update: used to build recalled list on scroll.
        const hasMsgListUpdate = args.some(
          (x) =>
            x &&
            Object.prototype.hasOwnProperty.call(x, "msgList") &&
            Array.isArray(x.msgList) &&
            x.msgList.length > 0,
        );

        if (hasMsgListUpdate) {
          let peerUid = "";
          const recalledIndex: number[] = [];

          for (const i in args[1].msgList) {
            const msg = args[1].msgList[i];
            peerUid = msg.peerUid;
            if (
              msg.msgType === 5 &&
              msg.subMsgType === 4 &&
              msg.elements?.[0]?.grayTipElement?.revokeElement &&
              (config.isAntiRecallSelfMsg ||
                !msg.elements[0].grayTipElement.revokeElement.isSelfOperate)
            ) {
              recalledIndex.push(Number(i));
            }
          }

          recalledIndex.sort((a, b) => b - a);

          for (const i of recalledIndex) {
            const recalled = args[1].msgList[i];
            const msgId = String(recalled.msgId);

            const fromFlow = msgFlowCache.find((x) => x.id === msgId);
            const fromRecalled = recalledCache.find((x) => x.id === msgId);
            const fromDb = await readFromDb(msgId);

            let record: any = null;
            let source = "";

            if (fromRecalled) {
              record = fromRecalled;
              source = "old msg";
            } else if (fromFlow) {
              if (!fromRecalled) recalledCache.push(fromFlow);
              record = fromFlow;
              source = "msgFlow";
            } else if (fromDb) {
              if (!fromRecalled) recalledCache.push(fromDb);
              record = fromDb;
              source = "dbMsg";
            }

            if (record?.msg && typeof record.msg === "object") {
              const recovered = { ...record.msg, isOnlineMsg: true };
              await imageDownloader.downloadPic(recovered);
              // 从库里读回来的记录 thumbPath 是普通对象（或早期存坏的 {}），
              // 渲染层按内核约定读 Map，所以补回 Map 形态；封面路径不在了
              // 就用 videoMd5 反推。这是重启后封面能回来的关键。
              restoreForKernel(recovered);
              log("Detected recall, intercepted and recovered from " + source);

              for (const k in recovered) {
                if (
                  [
                    "msgSeq",
                    "cntSeq",
                    "clientSeq",
                    "sendStatus",
                    "emojiLikesList",
                  ].includes(k)
                )
                  continue;

                const v = (recovered as any)[k];
                const old = recalled[k];

                let next = v;
                if (
                  ["msgAttrs", "msgMeta", "generalFlags"].includes(k) &&
                  v &&
                  typeof v === "object" &&
                  old &&
                  typeof old === "object"
                ) {
                  for (const kk in old) {
                    if (Object.prototype.hasOwnProperty.call(old, kk))
                      delete old[kk];
                  }
                  next = Object.assign(old, v);
                }

                recalled[k] = next;
              }
            }
          }

          wc.send(
            CH_MAIN.recallTipList,
            recalledCache
              .filter((x) => x.sender === peerUid || x?.sender == null)
              .map((x) => x.id),
          );
        }

        // cmdName update: used to detect realtime recall and cache incoming messages.
        const hasCmd = args.some(
          (x) =>
            x &&
            Object.prototype.hasOwnProperty.call(x, "cmdName") &&
            x.cmdName != null,
        );
        if (hasCmd) {
          const payloadWrapper = args[1];
          if (!payloadWrapper) return originalSend(channel, ...args);

          if (
            payloadWrapper.cmdName &&
            (payloadWrapper.cmdName.includes("onMsgInfoListUpdate") ||
              payloadWrapper.cmdName.includes("onActiveMsgInfoUpdate")) &&
            payloadWrapper.payload?.msgList instanceof Array &&
            payloadWrapper.payload.msgList[0]?.msgType === 5 &&
            payloadWrapper.payload.msgList[0]?.subMsgType === 4
          ) {
            const recallMsg = payloadWrapper.payload.msgList[0];
            const revoke =
              recallMsg.elements?.[0]?.grayTipElement?.revokeElement;
            if (
              revoke &&
              (config.isAntiRecallSelfMsg || !revoke.isSelfOperate)
            ) {
              const recallId = String(recallMsg.msgId);
              wc.send(CH_MAIN.recallTip, recallId);

              const cached = msgFlowCache.find((x) => x.id === recallId);
              const already = recalledCache.find((x) => x.id === recallId);

              if (cached && !already) {
                recalledCache.push(cached);
                if (config.saveDb) await saveToDb(cached);
              }

              await imageDownloader.downloadPic(cached?.msg);
              await imageDownloader.downloadPic(already?.msg);

              args[1].cmdName = "none";
              args[1].payload.msgList.pop();
              log("Detected recall, intercepted");
            }
          } else if (
            (payloadWrapper.cmdName &&
              payloadWrapper.payload &&
              (payloadWrapper.cmdName.includes("onRecvMsg") ||
                payloadWrapper.cmdName.includes("onRecvActiveMsg")) &&
              payloadWrapper.payload.msgList instanceof Array) ||
            (payloadWrapper.cmdName &&
              payloadWrapper.cmdName.includes("onAddSendMsg") &&
              payloadWrapper.payload?.msgRecord != null) ||
            (payloadWrapper.cmdName &&
              payloadWrapper.cmdName.includes("onMsgInfoListUpdate") &&
              payloadWrapper.payload?.msgList instanceof Array)
          ) {
            const list: any[] =
              payloadWrapper.payload.msgList instanceof Array
                ? payloadWrapper.payload.msgList
                : [payloadWrapper.payload.msgRecord];
            for (const msg of list) {
              const msgId = String(msg.msgId);
              videoPreloader.handleMsg(msg);
              let idx = msgFlowCache.findIndex((x) => x.id === msgId);
              if (idx === -1) {
                msgFlowCache.push({ id: msgId, sender: msg.peerUid, msg });
                idx = msgFlowCache.length - 1;
              }
              msgFlowCache[idx] = { id: msgId, sender: msg.peerUid, msg };

              if (config.enablePeriodicCleanup) {
                if (config.maxMsgSaveLimit == null)
                  config.maxMsgSaveLimit = 10_000;
                if (config.deleteMsgCountPerTime == null)
                  config.deleteMsgCountPerTime = 500;
                if (msgFlowCache.length > config.maxMsgSaveLimit)
                  msgFlowCache.splice(0, config.deleteMsgCountPerTime);
              }
            }
          }
        }
      }
    } catch (e) {
      // 别把用户导到上游 LiteLoader 仓库去报这里的 bug。
      log(
        "Anti-Recall 拦截出错: ",
        e,
        "请到 https://github.com/b1xcy/qwqnt-better-anti-recall/issues 反馈",
      );
    }

    return originalSend(channel, ...args);
  };

  if (wc.__qqntim_original_object)
    wc.__qqntim_original_object.send = wrappedSend;
  else wc.send = wrappedSend;

  log("NTQQ Anti-Recall patched for window:", win.id);
}

function log(...args: unknown[]): void {
  debugLog("[RecallViewer] lifecycle:", ...args);
}


/** 按 id 去重并丢掉形状不对的记录；后出现的覆盖先出现的。 */
function dedupeRecords(records: any[]): any[] {
  const byId = new Map<string, any>();
  for (const record of records) {
    const id = String(record?.id ?? "");
    if (id && record?.msg && typeof record.msg === "object")
      byId.set(id, record);
  }
  return Array.from(byId.values());
}

/**
 * 给查看器的记录补上解析好的封面/视频路径。
 *
 * 内存里的记录 thumbPath 是 Map，库里读回来的是普通对象或空 {}，让查看器
 * 自己猜形状迟早再踩一次坑。统一在主进程解析成字符串字段。
 *
 * 这里可以就地改：走到查看器的记录要么是库里读出来的临时对象，要么是
 * dedupeRecords 之后的引用，补两个字符串字段不影响内核那份数据。
 */
function annotateRecordsForViewer(records: any[]): any[] {
  for (const record of records) {
    try {
      annotateForViewer(record?.msg);
    } catch {
      // 单条解析失败不该毁掉整页
    }
  }
  return records;
}

function registerIpcHandlers(): void {
  ipcMain.handle(CH.getNowConfig, async () => config);

  /**
   * 倒序分页读取。第一页额外带上本次会话的内存缓存（最新的那批），
   * 之后每页从更老的分片取。查看器边收边渲染，不用等全库读完。
   */
  ipcMain.handle(
    CH.getRecalledPage,
    async (_event, cursor?: ShardPageCursor, maxShards?: number) => {
      const isFirstPage = cursor == null;

      if (!config.saveDb) {
        // 没开落盘时只有内存缓存这一份。
        return {
          records: isFirstPage
            ? annotateRecordsForViewer(dedupeRecords(recalledCache))
            : [],
          cursor: { total: 0, remaining: 0 },
          done: true,
        };
      }

      const page = await jsonStore.readPage(cursor, maxShards ?? 4);
      const records = isFirstPage
        ? dedupeRecords([...recalledCache, ...(page.records as any[])])
        : dedupeRecords(page.records as any[]);

      return {
        records: annotateRecordsForViewer(records),
        cursor: page.cursor,
        done: page.done,
      };
    },
  );

  ipcMain.on(CH.openRecallViewer, () => {
    if (recallViewerWindow && !recallViewerWindow.isDestroyed()) {
      recallViewerWindow.focus();
      return;
    }

    recallViewerWindow = new BrowserWindow({
      width: 900,
      height: 640,
      autoHideMenuBar: true,
      title: "撤回消息",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, "../preload/recallMsgViewer.cjs"),
      },
    });
    recallViewerWindow.setMenuBarVisibility(false);
    const pluginRoot = path.resolve(__dirname, "..");
    const viewerPath = path.join(
      pluginRoot,
      "renderer/pages/recallMsgViewer/index.html",
    );
    debugLog("[RecallViewer] opening", { pluginRoot, viewerPath, exists: fs.existsSync(viewerPath) });
    void recallViewerWindow.loadFile(viewerPath);
    recallViewerWindow.webContents.on("did-start-loading", () => {
      debugLog("[RecallViewer] loading");
    });
    recallViewerWindow.webContents.on("did-finish-load", () => {
      debugLog("[RecallViewer] loaded");
    });
    recallViewerWindow.webContents.on(
      "did-fail-load",
      (_event, code, description, url) => {
        debugLog("[RecallViewer] load failed:", { code, description, url });
      },
    );
    recallViewerWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      debugLog("[RecallViewer] console:", { level, message, line, sourceId });
    });
  });
  ipcMain.handle(
    CH.getStorageStatus,
    async (): Promise<StorageStatus> => {
      if (!config.saveDb)
        return { shardCount: 0, totalBytes: 0, recordCount: 0 };
      await jsonStore.init();
      return jsonStore.stats();
    },
  );

  ipcMain.handle(
    CH.saveConfig,
    async (_event, newConfig: AntiRecallConfig) => {
      config = normalizeConfig(newConfig);

      updateImageSaveDir();
      imageDownloader.setNapcatSource(
        config.enableNapcatRkey ? config.napcatRkeyUrl : "",
        config.enableNapcatRkey ? config.napcatRkeyToken : "",
      );
      imageDownloader.setSnowlumaSource(
        config.enableSnowlumaRkey ? config.snowlumaRkeyUrl : "",
        config.snowlumaPassword,
        config.snowlumaUin,
      );
      broadcast(CH_MAIN.repatchCss);

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    },
  );

  ipcMain.handle(
    CH.testNapcatRkey,
    async (_event, url: string, token: string) => {
      return await imageDownloader.testNapcatRkey(url, token);
    },
  );

  ipcMain.handle(
    CH.testSnowlumaRkey,
    async (_event, url: string, password: string, uin: string) => {
      return await imageDownloader.testSnowlumaRkey(url, password, uin);
    },
  );

  ipcMain.handle(CH.clearDb, async () => {
    const res = await dialog.showMessageBox({
      type: "warning",
      title: "警告",
      message: "清空所有已储存的撤回消息后不可恢复，是否确认清空？",
      buttons: ["确定", "取消"],
      cancelId: 1,
    });

    if (res.response !== 0) return;

    // 分片目录、旧分片目录、旧版单文件和迁移备份都一起清掉。
    jsonStore.clear();
    recalledCache.length = 0;
    try {
      if (fs.existsSync(imagesDir))
        fs.rmSync(imagesDir, { recursive: true, force: true });
    } catch {
      // ignore
    }

    await dialog.showMessageBox({
      type: "info",
      title: "提示",
      message:
        "清空完毕，之前保存的所有已撤回消息均被删除，重启 QQ 后就能看见效果。",
      buttons: ["确定"],
    });
  });
}

async function init(): Promise<void> {
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  configPath = path.join(configDir, "config.json");
  config = readConfig(); // 已经过 normalizeConfig，缺省值和废弃键都处理好了

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

  updateImageSaveDir();
  imageDownloader.setNapcatSource(
    config.enableNapcatRkey ? config.napcatRkeyUrl : "",
    config.enableNapcatRkey ? config.napcatRkeyToken : "",
  );
  imageDownloader.setSnowlumaSource(
    config.enableSnowlumaRkey ? config.snowlumaRkeyUrl : "",
    config.snowlumaPassword,
    config.snowlumaUin,
  );
  registerIpcHandlers();
  // 提前建索引/迁移，别等第一条撤回来了才做。
  if (config.saveDb) await jsonStore.init();

  (qwqnt as any).main.hooks.whenBrowserWindowCreated.peek((w: BrowserWindow) => {
    patchWindow(w);
    videoPreloader.attach(w);
  });
  for (const w of BrowserWindow.getAllWindows()) {
    if (w && !w.isDestroyed()) {
      patchWindow(w);
      videoPreloader.attach(w);
    }
  }
  // 窗口内部 '-ipc-message' 监听器是懒注册的，周期性补挂（幂等）
  setInterval(function () {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w && !w.isDestroyed()) {
        try {
          videoPreloader.attach(w);
        } catch (e) {}
      }
    }
  }, 5000);
}

void init();
