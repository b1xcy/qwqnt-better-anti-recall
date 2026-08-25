import fs from "node:fs";
import path from "node:path";
import { scanJsonObjectEntries } from "./jsonEntryScanner";

/**
 * 分片式 JSON 存储。
 *
 * 旧实现把所有撤回消息塞进一个 qq-recalled-db.json，并且每存一条就把整个
 * 对象重新序列化落盘。用久了文件会涨到几百 MB：编辑器打不开，每次写盘都要
 * 重写全量数据。
 *
 * 现在按 1 MB 切片存到 qq-recalled-db/ 目录下，写入只碰当前活跃分片，
 * 读取按需加载单个分片，遍历时逐片解析。
 */

export const DEFAULT_MAX_SHARD_BYTES = 1024 * 1024;

const MANIFEST_NAME = "manifest.json";
const MANIFEST_VERSION = 1;
const SHARD_PREFIX = "shard-";
const SHARD_SUFFIX = ".json";
const SHARD_RE = /^shard-(\d{6})\.json$/;
const LOADED_SHARD_CACHE = 3;
const YIELD_EVERY_SHARDS = 1;

function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

type ShardData = Record<string, unknown>;

interface ShardMeta {
  file: string;
  bytes: number;
  count: number;
}

interface Manifest {
  version: number;
  shards: ShardMeta[];
  /** 旧版单文件迁移完成的时间戳，用于判断是否需要再次迁移。 */
  migratedLegacyAt?: number;
}

export interface JsonShardStoreOptions {
  /** 分片目录。 */
  dir: string;
  /** 旧版单文件路径，存在时自动迁移。 */
  legacyFile?: string;
  /** 旧版分片目录，存在且 dir 还没建起来时整体改名搬过来。 */
  legacyDir?: string;
  maxShardBytes?: number;
  log?: (...args: unknown[]) => void;
}

export interface JsonShardStats {
  shardCount: number;
  totalBytes: number;
  recordCount: number;
}

/**
 * 倒序分页游标。`remaining` 是还没读的分片数（从最老那端算）。
 *
 * 快照 `total` 是为了分页途中有新撤回落盘时游标不错位：新分片总是追加在
 * 数组末尾，而倒序是从末尾往前走，不快照就会把刚写进来的那片当成起点。
 */
export interface ShardPageCursor {
  total: number;
  remaining: number;
}

export interface ShardPage {
  records: unknown[];
  cursor: ShardPageCursor;
  done: boolean;
}
export class JsonShardStore {
  private readonly dir: string;
  private readonly legacyFile: string | null;
  private readonly legacyDir: string | null;
  private readonly maxShardBytes: number;
  private readonly log: (...args: unknown[]) => void;

  private manifest: Manifest = { version: MANIFEST_VERSION, shards: [] };
  /** id -> 所在分片下标；init 时一次性建好，之后读写都是 O(1)。 */
  private index: Map<string, number> = new Map();
  /** 已解析分片的 LRU 缓存，键为分片文件名。 */
  private cache = new Map<string, ShardData>();
  private initPromise: Promise<void> | null = null;

  constructor(opts: JsonShardStoreOptions) {
    this.dir = opts.dir;
    this.legacyFile = opts.legacyFile ?? null;
    this.legacyDir = opts.legacyDir ?? null;
    this.maxShardBytes = opts.maxShardBytes ?? DEFAULT_MAX_SHARD_BYTES;
    this.log = opts.log ?? ((): void => {});
  }

  init(): Promise<void> {
    this.initPromise ??= this.doInit().catch((e) => {
      // 允许下次调用重试，否则一次偶发失败会永久锁死存储。
      this.initPromise = null;
      throw e;
    });
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    this.relocateLegacyDir();
    fs.mkdirSync(this.dir, { recursive: true });
    this.manifest = this.readManifest() ?? this.discoverManifest();
    await this.buildIndex();

    try {
      await this.migrateLegacy();
    } catch (e) {
      // 迁移失败不能挡住正常收发：旧文件留在原地，下次启动再试。
      this.log("[JsonShardStore] 迁移旧数据库失败:", e);
    }
  }

  async get(id: string): Promise<unknown | null> {
    await this.init();
    const shardIdx = this.index.get(id);
    if (shardIdx === undefined) return null;
    const meta = this.manifest.shards[shardIdx];
    if (!meta) return null;
    const data = this.loadShard(meta);
    return data[id] ?? null;
  }

  async has(id: string): Promise<boolean> {
    await this.init();
    return this.index.has(id);
  }

  /** 已存在时返回 false，不重复写入。 */
  async put(id: string, record: unknown): Promise<boolean> {
    await this.init();
    if (this.index.has(id)) return false;

    const shardIdx = this.ensureActiveShard();
    const meta = this.manifest.shards[shardIdx];
    const data = this.loadShard(meta);
    data[id] = record;

    this.writeShard(meta, data);
    meta.count = Object.keys(data).length;
    this.index.set(id, shardIdx);
    this.saveManifest();
    return true;
  }

  /** 读取所有分片里的记录。 */
  async readAll(): Promise<unknown[]> {
    await this.init();
    const out: unknown[] = [];
    for (let i = 0; i < this.manifest.shards.length; i++) {
      const data = this.parseShard(this.manifest.shards[i]);
      for (const key of Object.keys(data)) out.push(data[key]);
      // 同 buildIndex：别在主进程里一口气解析上百个分片。
      if (i % YIELD_EVERY_SHARDS === YIELD_EVERY_SHARDS - 1) await yieldToLoop();
    }
    return out;
  }

  /**
   * 从最新的分片往老的方向读一页。
   *
   * 分片是按写入顺序追加的，所以最后一片装的是最近的撤回。查看器先拿到
   * 这些，用户一打开就能看到有用的东西，剩下的边看边补。
   */
  async readPage(
    cursor?: ShardPageCursor,
    maxShards = 1,
  ): Promise<ShardPage> {
    await this.init();

    const total = cursor?.total ?? this.manifest.shards.length;
    const remaining = Math.min(
      cursor?.remaining ?? total,
      this.manifest.shards.length,
    );

    if (remaining <= 0)
      return { records: [], cursor: { total, remaining: 0 }, done: true };

    const end = remaining;
    const start = Math.max(0, end - Math.max(1, maxShards));

    const records: unknown[] = [];
    for (let i = end - 1; i >= start; i--) {
      const meta = this.manifest.shards[i];
      if (!meta) continue;
      const data = this.parseShard(meta);
      // 片内也倒序，让同一页里新的排在前面。
      const keys = Object.keys(data);
      for (let k = keys.length - 1; k >= 0; k--) records.push(data[keys[k]]);
      if (i > start) await yieldToLoop();
    }

    return {
      records,
      cursor: { total, remaining: start },
      done: start <= 0,
    };
  }

  /** 删除分片目录、旧版单文件以及迁移备份。 */
  clear(): void {
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
    } catch (e) {
      this.log("[JsonShardStore] 删除分片目录失败:", e);
    }

    // 搬迁失败时旧目录可能还在，一起清掉。
    if (this.legacyDir && this.legacyDir !== this.dir) {
      try {
        fs.rmSync(this.legacyDir, { recursive: true, force: true });
      } catch (e) {
        this.log("[JsonShardStore] 删除旧分片目录失败:", e);
      }
    }

    if (this.legacyFile) {
      for (const file of this.legacyRelatedFiles()) {
        try {
          fs.rmSync(file, { force: true });
        } catch (e) {
          this.log("[JsonShardStore] 删除旧数据库文件失败:", file, e);
        }
      }
    }

    this.manifest = { version: MANIFEST_VERSION, shards: [] };
    this.index = new Map();
    this.cache.clear();
    // 下次读写会重新 init（目录已被删掉，必须重建）。
    this.initPromise = null;
  }

  stats(): JsonShardStats {
    let totalBytes = 0;
    for (const meta of this.manifest.shards) totalBytes += meta.bytes;
    return {
      shardCount: this.manifest.shards.length,
      totalBytes,
      recordCount: this.index.size,
    };
  }
  private get manifestPath(): string {
    return path.join(this.dir, MANIFEST_NAME);
  }

  private readManifest(): Manifest | null {
    try {
      const raw = JSON.parse(
        fs.readFileSync(this.manifestPath, "utf-8"),
      ) as Manifest;
      if (raw?.version !== MANIFEST_VERSION || !Array.isArray(raw.shards))
        return null;
      // 丢掉清单里已经不存在的分片文件。
      const shards = raw.shards.filter(
        (s) => s?.file && fs.existsSync(path.join(this.dir, s.file)),
      );
      return { ...raw, shards };
    } catch {
      return null;
    }
  }

  /** 清单丢失/损坏时，按目录里的分片文件重建。 */
  private discoverManifest(): Manifest {
    let files: string[] = [];
    try {
      files = fs
        .readdirSync(this.dir)
        .filter((f) => SHARD_RE.test(f))
        .sort();
    } catch {
      files = [];
    }

    const shards: ShardMeta[] = files.map((file) => {
      let bytes = 0;
      try {
        bytes = fs.statSync(path.join(this.dir, file)).size;
      } catch {
        // ignore
      }
      return { file, bytes, count: 0 };
    });

    if (shards.length > 0)
      this.log("[JsonShardStore] 清单缺失，已按目录重建:", shards.length, "个分片");
    return { version: MANIFEST_VERSION, shards };
  }

  private saveManifest(): void {
    try {
      this.atomicWrite(this.manifestPath, JSON.stringify(this.manifest));
    } catch (e) {
      this.log("[JsonShardStore] 写入清单失败:", e);
    }
  }

  /**
   * 解析全部分片建立 id 索引；只保留 id，解析出的数据随即丢弃。
   *
   * 这段跑在主进程里，库大了会有上千毫秒。每片之间让出一次事件循环，
   * 避免把 QQ 界面卡住——单片只有 1 MB，一次解析是毫秒级的。
   */
  private async buildIndex(): Promise<void> {
    const index = new Map<string, number>();
    for (let i = 0; i < this.manifest.shards.length; i++) {
      const meta = this.manifest.shards[i];
      const data = this.parseShard(meta);
      const keys = Object.keys(data);
      for (const key of keys) index.set(key, i);
      meta.count = keys.length;
      if (i % YIELD_EVERY_SHARDS === YIELD_EVERY_SHARDS - 1) await yieldToLoop();
    }
    this.index = index;
  }

  private parseShard(meta: ShardMeta): ShardData {
    const cached = this.cache.get(meta.file);
    if (cached) return cached;
    try {
      return JSON.parse(
        fs.readFileSync(path.join(this.dir, meta.file), "utf-8"),
      ) as ShardData;
    } catch (e) {
      this.log("[JsonShardStore] 分片解析失败，按空处理:", meta.file, e);
      return {};
    }
  }

  private loadShard(meta: ShardMeta): ShardData {
    const cached = this.cache.get(meta.file);
    if (cached) {
      // 刷新 LRU 位置。
      this.cache.delete(meta.file);
      this.cache.set(meta.file, cached);
      return cached;
    }

    const data = this.parseShard(meta);
    this.cache.set(meta.file, data);
    while (this.cache.size > LOADED_SHARD_CACHE) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return data;
  }

  private writeShard(meta: ShardMeta, data: ShardData): void {
    const text = JSON.stringify(data);
    this.atomicWrite(path.join(this.dir, meta.file), text);
    meta.bytes = Buffer.byteLength(text, "utf-8");
    this.cache.set(meta.file, data);
  }

  /** 先写临时文件再改名，避免写一半崩了把整个分片写坏。 */
  private atomicWrite(target: string, text: string): void {
    const tmp = `${target}.tmp`;
    try {
      fs.writeFileSync(tmp, text, "utf-8");
      fs.renameSync(tmp, target);
    } catch (e) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // ignore
      }
      // 改名失败（杀软占用等）时退回直接写。
      fs.writeFileSync(target, text, "utf-8");
      void e;
    }
  }

  /** 返回可继续追加的分片下标，必要时新建分片。 */
  private ensureActiveShard(): number {
    const last = this.manifest.shards.at(-1);
    if (last && last.bytes < this.maxShardBytes)
      return this.manifest.shards.length - 1;

    this.manifest.shards.push({ file: this.nextShardFile(), bytes: 0, count: 0 });
    return this.manifest.shards.length - 1;
  }

  private nextShardFile(): string {
    let maxSeq = 0;
    for (const meta of this.manifest.shards) {
      const m = SHARD_RE.exec(meta.file);
      if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
    }
    const seq = String(maxSeq + 1).padStart(6, "0");
    return `${SHARD_PREFIX}${seq}${SHARD_SUFFIX}`;
  }
  /**
   * 分片目录换了位置时整体改名搬过来。
   *
   * 只在新目录还不存在时搬，避免把已经在用的新目录覆盖掉。改名是原子的，
   * 不会出现搬一半的状态；跨盘失败则退回逐文件拷贝。
   */
  private relocateLegacyDir(): void {
    const from = this.legacyDir;
    if (!from || from === this.dir) return;
    if (!fs.existsSync(from)) return;
    if (fs.existsSync(this.dir)) {
      this.log("[JsonShardStore] 新旧分片目录同时存在，保留新目录:", this.dir);
      return;
    }

    try {
      fs.mkdirSync(path.dirname(this.dir), { recursive: true });
      fs.renameSync(from, this.dir);
      this.log("[JsonShardStore] 分片目录已迁移:", from, "->", this.dir);
    } catch (e) {
      try {
        fs.cpSync(from, this.dir, { recursive: true });
        fs.rmSync(from, { recursive: true, force: true });
        this.log("[JsonShardStore] 分片目录已复制迁移:", from, "->", this.dir);
      } catch (e2) {
        this.log("[JsonShardStore] 分片目录迁移失败:", e, e2);
      }
    }
  }

  /** 旧版单文件本体 + 迁移备份。 */
  private legacyRelatedFiles(): string[] {
    if (!this.legacyFile) return [];
    const out = [this.legacyFile];
    const dir = path.dirname(this.legacyFile);
    const base = path.basename(this.legacyFile);
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(`${base}.migrated-`)) out.push(path.join(dir, f));
      }
    } catch {
      // ignore
    }
    return out;
  }

  /**
   * 把旧版单文件流式切成分片。
   *
   * 中途崩溃也能接着来：已落盘的分片都写进了清单，重跑时 id 索引会把
   * 已迁移的记录跳过。
   */
  private async migrateLegacy(): Promise<void> {
    const legacy = this.legacyFile;
    if (!legacy) return;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(legacy);
    } catch {
      return; // 没有旧文件，正常路径
    }
    if (!stat.isFile()) return;

    const migratedAt = this.manifest.migratedLegacyAt ?? 0;
    if (migratedAt && stat.mtimeMs <= migratedAt) {
      // 迁移过但归档没成功，补一次改名。
      this.archiveLegacy();
      return;
    }

    const startedAt = Date.now();
    this.log(
      "[JsonShardStore] 开始迁移旧数据库:",
      legacy,
      `${stat.size} 字节`,
    );

    let migrated = 0;
    let skipped = 0;
    let batch: string[] = [];
    let batchBytes = 0;

    const flush = (): void => {
      if (batch.length === 0) return;
      const file = this.nextShardFile();
      const text = `{${batch.join(",")}}`;
      this.atomicWrite(path.join(this.dir, file), text);
      this.manifest.shards.push({
        file,
        bytes: Buffer.byteLength(text, "utf-8"),
        count: batch.length,
      });
      this.saveManifest();
      batch = [];
      batchBytes = 0;
    };

    const result = await scanJsonObjectEntries(legacy, (key, valueText) => {
      if (this.index.has(key)) {
        skipped++;
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(valueText);
      } catch {
        skipped++;
        return;
      }
      if (parsed === null || typeof parsed !== "object") {
        skipped++;
        return;
      }

      const piece = `${JSON.stringify(key)}:${JSON.stringify(parsed)}`;
      batch.push(piece);
      batchBytes += Buffer.byteLength(piece, "utf-8") + 1;
      // flush 总是追加到末尾，所以目标下标就是当前长度。
      this.index.set(key, this.manifest.shards.length);
      migrated++;

      if (batchBytes >= this.maxShardBytes) flush();
    });

    flush();

    if (!result.complete)
      this.log(
        "[JsonShardStore] 旧数据库结尾不完整（可能被截断），已尽量抢救出的记录数:",
        migrated,
      );

    this.manifest.migratedLegacyAt = Date.now();
    this.saveManifest();
    this.log(
      "[JsonShardStore] 迁移完成:",
      `${migrated} 条`,
      `${this.manifest.shards.length} 个分片`,
      `跳过 ${skipped} 条`,
      `${Date.now() - startedAt} ms`,
    );

    this.archiveLegacy();
  }

  /** 迁移后把旧文件改名留底，而不是直接删掉。 */
  private archiveLegacy(): void {
    const legacy = this.legacyFile;
    if (!legacy || !fs.existsSync(legacy)) return;
    const target = `${legacy}.migrated-${Date.now()}.bak`;
    try {
      fs.renameSync(legacy, target);
      this.log("[JsonShardStore] 旧数据库已备份为:", target);
    } catch (e) {
      this.log("[JsonShardStore] 备份旧数据库失败（保持原样）:", e);
    }
  }
}
