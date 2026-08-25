export interface PagedRecord {
  id: string;
  sender?: string;
  msg: any;
}

interface Cursor {
  total: number;
  remaining: number;
}

interface Page {
  records: PagedRecord[];
  cursor: Cursor;
  done: boolean;
}

export interface PagedApi {
  getRecalledPage: (cursor?: Cursor, maxShards?: number) => Promise<Page>;
}

/** 每页取几个分片。小了往返太多，大了单页阻塞变长。 */
const SHARDS_PER_PAGE = 4;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function")
      requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/**
 * 倒序分页把撤回记录读完。
 *
 * 最近的分片先到，所以 onProgress 第一次被调用时用户已经能看到有用内容，
 * 老数据在后面几页陆续补上。每次回调传的是「累积到目前为止的全部记录」，
 * 调用方直接整体重渲染就行，不用自己维护增量状态。
 */
export async function loadRecalledPaged(
  api: PagedApi,
  onProgress: (records: PagedRecord[], done: boolean) => void,
): Promise<PagedRecord[]> {
  const byId = new Map<string, PagedRecord>();
  let cursor: Cursor | undefined;
  let guard = 0;

  for (;;) {
    const page = await api.getRecalledPage(cursor, SHARDS_PER_PAGE);
    for (const record of page.records ?? []) {
      const id = String(record?.id ?? "");
      if (id && record?.msg && typeof record.msg === "object")
        byId.set(id, record);
    }

    const records = Array.from(byId.values());
    onProgress(records, Boolean(page.done));
    if (page.done) return records;

    // 游标没往前走就停，别把主进程问死。
    const prev = cursor?.remaining ?? Number.POSITIVE_INFINITY;
    cursor = page.cursor;
    if (!cursor || cursor.remaining >= prev) return records;
    if (++guard > 10_000) return records;

    // 让浏览器把这一页画出来再要下一页。
    await nextFrame();
  }
}
