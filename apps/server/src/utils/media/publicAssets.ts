import { randomBytes } from "node:crypto";

type Entry = { bytes: Uint8Array; mimeType: string; expiresAt: number };

// ACT: 单进程内存缓存；素材只在一次视频任务的有效期内被 Agnes 拉取，过期即释放，不落盘。
const entries = new Map<string, Entry>();
const ttlMs = 60 * 60_000;
const maxEntries = 200;
const maxBytes = 15 * 1024 * 1024;

const timer = setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of entries) if (entry.expiresAt <= now) entries.delete(token);
}, 60_000);
timer.unref?.();

function readBytes(input: MediaInput) {
  if (input.type === "base64") {
    const content = input.data.replace(/^data:[^;]+;base64,/, "").replace(/\s/g, "");
    return Buffer.from(content, "base64");
  }
  if (input.type === "binary") return Buffer.from(input.data);
  return undefined;
}

/**
 * 把参考素材登记为可公开访问的临时地址，返回 URL；无法登记时返回 undefined，由调用方回退原始内容。
 * @param baseUrl 已配置的公网地址，不含结尾斜杠。
 */
export function register(baseUrl: string, input: MediaInput): string | undefined {
  if (!baseUrl) return undefined;
  if (input.type === "url") return /^https?:\/\//i.test(input.url) ? input.url : undefined;
  const bytes = readBytes(input);
  if (!bytes?.byteLength || bytes.byteLength > maxBytes) return undefined;
  const token = randomBytes(32).toString("hex");
  if (entries.size >= maxEntries) entries.delete(entries.keys().next().value!);
  entries.set(token, { bytes, mimeType: input.mimeType, expiresAt: Date.now() + ttlMs });
  return `${baseUrl}/api/media/public/${token}`;
}

export function read(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) return undefined;
  const entry = entries.get(token);
  if (!entry || entry.expiresAt <= Date.now()) {
    entries.delete(token);
    return undefined;
  }
  return entry;
}
