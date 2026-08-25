import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

/**
 * 流式扫描一个 JSON 对象的顶层键值对。
 *
 * 迁移旧版单文件数据库时不能用 readFileSync + JSON.parse：几百 MB 的文件
 * 会先撑出一个同样大的字符串，再撑出上 GB 的对象图，很容易直接把主进程
 * 撑死。这里边读边切，内存占用只和单条记录的大小相关。
 */

export interface ScanResult {
  /** 是否完整读到根对象的收尾括号；false 说明文件被截断或损坏。 */
  complete: boolean;
  /** 实际吐出的顶层键值对数量。 */
  entries: number;
}

const CHUNK_BYTES = 1 << 20;

const CH_QUOTE = 0x22;
const CH_COMMA = 0x2c;
const CH_COLON = 0x3a;
const CH_BACKSLASH = 0x5c;
const CH_LBRACKET = 0x5b;
const CH_RBRACKET = 0x5d;
const CH_LBRACE = 0x7b;
const CH_RBRACE = 0x7d;
const CH_BOM = 0xfeff;

function isSkippable(c: number): boolean {
  return (
    c === 0x20 ||
    c === 0x09 ||
    c === 0x0a ||
    c === 0x0d ||
    c === CH_COMMA ||
    c === CH_BOM
  );
}

function skipWs(s: string, start: number): number {
  let i = start;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
    else break;
  }
  return i;
}
/** start 指向左引号，返回右引号之后的位置；缓冲区不够时返回 -1。 */
function scanStringEnd(s: string, start: number): number {
  let i = start + 1;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === CH_BACKSLASH) {
      i += 2;
      continue;
    }
    if (c === CH_QUOTE) return i + 1;
    i++;
  }
  return -1;
}

/** start 指向 { 或 [，返回配对括号之后的位置；缓冲区不够时返回 -1。 */
function scanContainerEnd(s: string, start: number): number {
  let depth = 0;
  let i = start;
  let inStr = false;

  while (i < s.length) {
    const c = s.charCodeAt(i);

    if (inStr) {
      if (c === CH_BACKSLASH) {
        i += 2;
        continue;
      }
      if (c === CH_QUOTE) inStr = false;
      i++;
      continue;
    }

    if (c === CH_QUOTE) {
      inStr = true;
    } else if (c === CH_LBRACE || c === CH_LBRACKET) {
      depth++;
    } else if (c === CH_RBRACE || c === CH_RBRACKET) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

/** 返回值结束后的位置；缓冲区不够时返回 -1。 */
function scanValueEnd(s: string, start: number, atEof: boolean): number {
  const c = s.charCodeAt(start);
  if (c === CH_QUOTE) return scanStringEnd(s, start);
  if (c === CH_LBRACE || c === CH_LBRACKET) return scanContainerEnd(s, start);

  // 字面量（数字 / true / false / null），读到分隔符为止。
  let i = start;
  while (i < s.length) {
    const cc = s.charCodeAt(i);
    if (
      cc === CH_COMMA ||
      cc === CH_RBRACE ||
      cc === CH_RBRACKET ||
      cc === 0x20 ||
      cc === 0x09 ||
      cc === 0x0a ||
      cc === 0x0d
    )
      return i;
    i++;
  }
  // 文件到底了，剩下的整段就是这个字面量。
  return atEof ? i : -1;
}
/**
 * 逐条吐出根对象的顶层键值对。`valueText` 是未经解析的原始 JSON 片段，
 * 由调用方决定是校验、改写还是直接落盘。
 */
export async function scanJsonObjectEntries(
  filePath: string,
  onEntry: (key: string, valueText: string) => void,
): Promise<ScanResult> {
  const decoder = new StringDecoder("utf8");
  let buf = "";
  let pos = 0;
  let started = false;
  let finished = false;
  let entries = 0;

  // 每次调用尽量多消费；数据不足时原地返回，等下一个 chunk。
  const drain = (atEof: boolean): void => {
    for (;;) {
      while (pos < buf.length && isSkippable(buf.charCodeAt(pos))) pos++;
      if (pos >= buf.length) return;

      if (!started) {
        if (buf.charCodeAt(pos) !== CH_LBRACE)
          throw new Error("根节点不是 JSON 对象");
        started = true;
        pos++;
        continue;
      }

      if (buf.charCodeAt(pos) === CH_RBRACE) {
        finished = true;
        pos++;
        return;
      }

      if (buf.charCodeAt(pos) !== CH_QUOTE)
        throw new Error(
          `顶层出现意外字符: ${JSON.stringify(buf.slice(pos, pos + 24))}`,
        );

      const keyEnd = scanStringEnd(buf, pos);
      if (keyEnd === -1) return;

      let valueStart = skipWs(buf, keyEnd);
      if (valueStart >= buf.length) return;
      if (buf.charCodeAt(valueStart) !== CH_COLON)
        throw new Error("键之后缺少 ':'");

      valueStart = skipWs(buf, valueStart + 1);
      if (valueStart >= buf.length) return;

      const valueEnd = scanValueEnd(buf, valueStart, atEof);
      if (valueEnd === -1) return;

      onEntry(
        JSON.parse(buf.slice(pos, keyEnd)) as string,
        buf.slice(valueStart, valueEnd),
      );
      entries++;
      pos = valueEnd;
    }
  };

  const stream = fs.createReadStream(filePath, {
    highWaterMark: CHUNK_BYTES,
  });

  try {
    for await (const chunk of stream) {
      buf += decoder.write(chunk as Buffer);
      drain(false);
      if (finished) break;
      if (pos > 0) {
        buf = buf.slice(pos);
        pos = 0;
      }
    }
  } finally {
    stream.destroy();
  }

  if (!finished) {
    buf += decoder.end();
    drain(true);
  }

  return { complete: finished, entries };
}
