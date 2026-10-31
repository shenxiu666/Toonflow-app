import { createHash } from "node:crypto";
import { readFile, writeAtomic } from "@toonflow/file";
import { dirname, join } from "node:path";
import conf from "@/utils/conf";

type RemoteRecord = { url: string; providerId: string; recordedAt: number };
type StoredRecords = { version: 1; records: Record<string, RemoteRecord> };

const records = new Map<string, RemoteRecord>();
const probes = new Map<string, Promise<boolean>>();
let loaded: Promise<void> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

// ACT: 探活结果只缓存 5 分钟，避免每次都发 HEAD 又不会长期沿用过期结论。
const probeTtlMs = 5 * 60_000;
const probeCache = new Map<string, { ok: boolean; checkedAt: number }>();
const probeTimeoutMs = 8000;
// ACT: 单进程内存 + 数据目录快照，最多 5000 条；超出后按记录时间淘汰最旧的。
const maxRecords = 5000;

function storePath() {
  return join(dirname(conf.path), "agnesRemoteAssets.json");
}

function keyOf(directory: string, path: string) {
  const absolute = join(directory, path).replace(/\\/g, "/").toLowerCase();
  return createHash("sha256").update(absolute).digest("hex").slice(0, 32);
}

function scheduleSave() {
  if (saveTimer !== undefined) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    if (records.size > maxRecords) {
      const sorted = [...records.entries()].sort((left, right) => left[1].recordedAt - right[1].recordedAt);
      for (const [key] of sorted.slice(0, records.size - maxRecords)) records.delete(key);
    }
    const data: StoredRecords = { version: 1, records: Object.fromEntries(records) };
    // ACT: 只记录本地文件与远端地址的对应关系，不含任何密钥。
    void writeAtomic(storePath(), JSON.stringify(data), { mode: 0o600 }).catch(() => {});
  }, 2000);
  saveTimer.unref?.();
}

async function load() {
  if (loaded) return loaded;
  loaded = (async () => {
    const text = await readFile(storePath(), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!text) return;
    try {
      const parsed = JSON.parse(text) as StoredRecords;
      if (parsed?.version === 1 && parsed.records && typeof parsed.records === "object") {
        for (const [key, value] of Object.entries(parsed.records)) {
          if (value && typeof value.url === "string" && value.url) records.set(key, value);
        }
      }
    } catch {
      // ACT: 损坏的索引按空处理，退回重新探测，不影响生成。
    }
  })();
  return loaded;
}

/** 记录本地文件对应的远端公网地址，供后续作为视频参考素材直接复用。 */
export function remember(directory: string, path: string, url: string, providerId: string) {
  if (!/^https?:\/\//i.test(url)) return;
  records.set(keyOf(directory, path), { url, providerId, recordedAt: Date.now() });
  scheduleSave();
}

async function probeOnce(url: string) {
  // ACT: 先 HEAD；部分存储服务不支持 HEAD 时再用 Range GET 取首字节确认可读。
  const attempt = async (method: "HEAD" | "GET") => {
    const response = await fetch(url, {
      method,
      headers: method === "GET" ? { Range: "bytes=0-0" } : undefined,
      signal: AbortSignal.timeout(probeTimeoutMs),
      redirect: "follow",
    });
    await response.body?.cancel().catch(() => {});
    return response.status >= 200 && response.status < 400;
  };
  try {
    if (await attempt("HEAD")) return true;
  } catch { /* HEAD 失败后继续尝试 GET。 */ }
  try {
    return await attempt("GET");
  } catch {
    return false;
  }
}

/** 判断远端地址当前是否仍可访问；结果短时缓存并合并并发探测。 */
export function probe(url: string) {
  const cached = probeCache.get(url);
  if (cached && cached.checkedAt + probeTtlMs > Date.now()) return Promise.resolve(cached.ok);
  const running = probes.get(url);
  if (running) return running;
  const task = probeOnce(url)
    .then(ok => {
      probeCache.set(url, { ok, checkedAt: Date.now() });
      return ok;
    })
    .catch(() => false)
    .finally(() => { probes.delete(url); });
  probes.set(url, task);
  return task;
}

/**
 * 取本地文件此前记录的远端地址，并确认它现在仍然有效。
 * 没有记录或已失效时返回 undefined，由调用方回退到其他传输方式。
 */
export async function resolve(directory: string, path: string) {
  await load();
  const record = records.get(keyOf(directory, path));
  if (!record) return undefined;
  if (!(await probe(record.url))) {
    records.delete(keyOf(directory, path));
    scheduleSave();
    return undefined;
  }
  return record.url;
}

/** 供悬浮窗展示：本地文件是否有可直接复用的远端地址。 */
export async function count() {
  await load();
  return records.size;
}
