import { createHash } from "node:crypto";
import { readFile, writeAtomic } from "@toonflow/file";
import { dirname, join } from "node:path";
import conf from "@/utils/conf";
import { count as remoteAssetCount } from "@/utils/media/remoteAssets";

type MediaType = "image" | "video";
type Stamp = { at: number; tier: string };
type LeaseRequest = { mediaType: MediaType; size?: string; videoSeconds?: number; signal?: AbortSignal };

type StoredKey = { day: string; imageCount: number; videoSeconds: number; invalid: boolean; lastError?: string };
type StoredPool = { version: 1; keys: Record<string, StoredKey> };

type KeyState = {
  id: string;
  key: string;
  label: string;
  masked: string;
  inFlight: number;
  imageStamps: Stamp[];
  videoStamps: Stamp[];
  day: string;
  imageCount: number;
  videoSeconds: number;
  invalid: boolean;
  lastError: string;
  progress?: number;
};

export type KeySnapshot = {
  id: string;
  label: string;
  masked: string;
  inFlight: number;
  imageCount: number;
  videoSeconds: number;
  rpmResetInMs: number;
  blockedTiers: string[];
  dailyResetInMs: number;
  invalid: boolean;
  lastError: string;
  progress?: number;
};

export type PoolSnapshot = {
  configured: boolean;
  queued: number;
  /** 可复用远端地址的本地素材数量，供悬浮窗展示。 */
  remoteAssetCount: number;
  dailyImageLimit: number;
  dailyVideoSecondLimit: number;
  limits: { imageRpm: Record<string, number>; imageConcurrency: Record<string, number>; videoRpm: number; videoConcurrency: number };
  keys: KeySnapshot[];
};

export type KeyLease = {
  key: string;
  id: string;
  succeed(options?: { videoSeconds?: number }): void;
  /** 返回是否可换 Key 立即重试（429）。 */
  fail(error: unknown): boolean;
  /** 视频任务进度 0-100，仅用于悬浮窗展示。 */
  progress(value: number): void;
};

const windowMs = 60_000;
// ACT: 免费档位限流（见《Agnes限制.md》）；官方调整时只改这两张表。
const imageRpm: Record<string, number> = { "1K": 20, "2K": 10, "3K": 1, "4K": 1 };
const imageConcurrency: Record<string, number> = { "1K": 4, "2K": 3, "3K": 1, "4K": 1 };
// ACT: 视频 1 RPM 是硬限制，单 Key 同时只跑一个任务，轮询期间不与其他任务抢同一 Key。
const videoRpm = 1;
const videoConcurrency = 1;

type QueueItem = {
  request: LeaseRequest;
  resolve: (lease: KeyLease) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abort: () => void;
  timer?: ReturnType<typeof setTimeout>;
};

const keys = new Map<string, KeyState>();
const queue: QueueItem[] = [];
let stored: StoredPool = { version: 1, keys: {} };
let loaded: Promise<void> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let drainTimer: ReturnType<typeof setTimeout> | undefined;

function config() {
  const configs = conf.get("settings", {}).mediaProviderConfigs as Record<string, Record<string, unknown>> | undefined;
  const value = configs?.agnes;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function positive(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function dailyImageLimit() {
  return positive(config().dailyImageLimit);
}

function dailyVideoSecondLimit() {
  return positive(config().dailyVideoSecondLimit);
}

function parseKeys() {
  const value = config().apiKeys;
  if (typeof value !== "string") return [];
  return [...new Set(value.split(/[\r\n,]+/).map(item => item.trim().replace(/^Bearer\s+/i, "").trim()).filter(Boolean))];
}

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function dailyResetInMs() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0).getTime() - now.getTime();
}

function hashKey(key: string) {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

function mask(key: string) {
  if (key.length <= 10) return `${key.slice(0, 2)}…${key.slice(-2)}`;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

function poolPath() {
  return join(dirname(conf.path), "agnesPool.json");
}

function scheduleSave() {
  if (saveTimer !== undefined) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    const data: StoredPool = { version: 1, keys: {} };
    for (const state of keys.values()) {
      data.keys[state.id] = {
        day: state.day, imageCount: state.imageCount, videoSeconds: state.videoSeconds,
        invalid: state.invalid, ...(state.lastError ? { lastError: state.lastError } : {}),
      };
    }
    // ACT: 只落盘 Key 摘要与计数，明文 Key 始终留在 settings.json。
    void writeAtomic(poolPath(), JSON.stringify(data), { mode: 0o600 }).catch(() => {});
  }, 2000);
  saveTimer.unref?.();
}

async function load() {
  if (loaded) return loaded;
  loaded = (async () => {
    const text = await readFile(poolPath(), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!text) return;
    try {
      const parsed = JSON.parse(text) as StoredPool;
      if (parsed?.version === 1 && parsed.keys && typeof parsed.keys === "object") stored = parsed;
    } catch {
      // ACT: 损坏的计数文件按空池处理，不影响生成。
    }
  })();
  return loaded;
}

function syncKeys() {
  const values = parseKeys();
  const day = today();
  const seen = new Set<string>();
  let index = 0;
  for (const key of values) {
    const id = hashKey(key);
    if (seen.has(id)) continue;
    seen.add(id);
    index++;
    const existing = keys.get(id);
    if (existing) {
      existing.label = `Key #${index}`;
      existing.key = key;
      if (existing.day !== day) {
        existing.day = day;
        existing.imageCount = 0;
        existing.videoSeconds = 0;
      }
      continue;
    }
    const saved = stored.keys[id];
    keys.set(id, {
      id, key, label: `Key #${index}`, masked: mask(key), inFlight: 0, imageStamps: [], videoStamps: [],
      day, imageCount: saved?.day === day ? saved.imageCount : 0,
      videoSeconds: saved?.day === day ? saved.videoSeconds : 0,
      invalid: saved?.invalid === true, lastError: saved?.lastError ?? "",
    });
  }
  for (const id of [...keys.keys()]) if (!seen.has(id)) keys.delete(id);
}

function trim(stamps: Stamp[], now: number) {
  while (stamps.length && stamps[0]!.at <= now - windowMs) stamps.shift();
  return stamps;
}

function tierOf(size: string | undefined) {
  const value = (size ?? "").trim().toUpperCase();
  return Object.hasOwn(imageRpm, value) ? value : "2K";
}

function imageLimit(tier: string) {
  return { rpm: imageRpm[tier] ?? imageRpm["2K"]!, concurrency: imageConcurrency[tier] ?? imageConcurrency["2K"]! };
}

function stampsOf(state: KeyState, mediaType: MediaType) {
  return mediaType === "video" ? state.videoStamps : state.imageStamps;
}

/** 同一分钟窗口内，图片按分辨率档位分别计数，视频统一 1 RPM。 */
function usedInWindow(state: KeyState, mediaType: MediaType, tier: string, now: number) {
  const stamps = trim(stampsOf(state, mediaType), now);
  return mediaType === "video" ? stamps.length : stamps.filter(stamp => stamp.tier === tier).length;
}

function windowResetInMs(state: KeyState, mediaType: MediaType, tier: string, limit: number, now: number) {
  const stamps = trim(stampsOf(state, mediaType), now);
  const matched = mediaType === "video" ? stamps : stamps.filter(stamp => stamp.tier === tier);
  if (matched.length < limit) return 0;
  return Math.max(0, matched[matched.length - limit]!.at + windowMs - now);
}

function available(state: KeyState, request: LeaseRequest, now: number) {
  if (state.invalid) return false;
  const tier = tierOf(request.size);
  const limit = request.mediaType === "video" ? { rpm: videoRpm, concurrency: videoConcurrency } : imageLimit(tier);
  if (state.inFlight >= limit.concurrency) return false;
  // ACT: 视频按「任务进行中占用、完成即释放」调度；1 RPM 只限制提交频率，不阻塞已完成任务的 Key。
  if (request.mediaType === "image" && usedInWindow(state, request.mediaType, tier, now) >= limit.rpm) return false;
  if (request.mediaType === "image") {
    const cap = dailyImageLimit();
    if (cap && state.imageCount >= cap) return false;
  } else {
    const cap = dailyVideoSecondLimit();
    if (cap && state.videoSeconds >= cap) return false;
  }
  return true;
}

function lastUsedAt(state: KeyState) {
  const latest = (stamps: Stamp[]) => stamps.length ? stamps[stamps.length - 1]!.at : 0;
  return Math.max(latest(state.imageStamps), latest(state.videoStamps));
}

function createLease(state: KeyState, request: LeaseRequest, stamp: Stamp): KeyLease {
  let settled = false;
  state.inFlight++;
  const release = () => {
    state.inFlight = Math.max(0, state.inFlight - 1);
    state.progress = undefined;
    drain();
  };
  return {
    key: state.key,
    id: state.id,
    progress(value) {
      if (settled) return;
      // ACT: 只保存当前任务进度，供悬浮窗展示；视频完成后清空。
      state.progress = Math.min(100, Math.max(0, Math.round(value)));
    },
    succeed(options) {
      if (settled) return;
      settled = true;
      if (request.mediaType === "image") state.imageCount++;
      else state.videoSeconds += Math.max(0, Math.round(options?.videoSeconds ?? request.videoSeconds ?? 0));
      scheduleSave();
      release();
    },
    fail(error) {
      if (settled) return false;
      settled = true;
      const status = (error as { status?: number } | null)?.status;
      if (status === 429) {
        // ACT: 429 说明请求未被受理，回滚本次占用的窗口名额，允许换 Key 立即重试。
        const stamps = stampsOf(state, request.mediaType);
        const index = stamps.lastIndexOf(stamp);
        if (index >= 0) stamps.splice(index, 1);
      } else if (status === 401 || status === 403) {
        state.invalid = true;
        state.lastError = error instanceof Error ? error.message : "API Key 已失效";
      } else if (error instanceof Error) {
        state.lastError = error.message.slice(0, 300);
      }
      scheduleSave();
      release();
      // ACT: 429 与 401/403 都应换 Key 重试；后者已标记失效，换下一个 Key 才有意义。
      return status === 429 || status === 401 || status === 403;
    },
  };
}

function tryPick(request: LeaseRequest): KeyLease | undefined {
  const now = Date.now();
  let best: KeyState | undefined;
  for (const state of keys.values()) {
    if (!available(state, request, now)) continue;
    // ACT: 优先负载最低、最近最少使用的 Key，多个 Key 自然均摊而不是集中在第一个。
    if (!best || state.inFlight < best.inFlight
      || (state.inFlight === best.inFlight && lastUsedAt(state) < lastUsedAt(best))) best = state;
  }
  if (!best) return undefined;
  const stamp: Stamp = { at: now, tier: tierOf(request.size) };
  // ACT: 视频只靠 inFlight 表达占用，不写入滑动窗口，任务完成即可再次提交。
  if (request.mediaType === "image") stampsOf(best, request.mediaType).push(stamp);
  return createLease(best, request, stamp);
}

function nextWakeInMs() {
  const now = Date.now();
  let wait = Infinity;
  for (const item of queue) {
    for (const state of keys.values()) {
      if (state.invalid) continue;
      const tier = tierOf(item.request.size);
      const limit = item.request.mediaType === "video" ? videoRpm : imageLimit(tier).rpm;
      const reset = windowResetInMs(state, item.request.mediaType, tier, limit, now);
      if (reset > 0) wait = Math.min(wait, reset);
    }
  }
  return wait;
}

function drain() {
  if (!queue.length) {
    if (drainTimer !== undefined) { clearTimeout(drainTimer); drainTimer = undefined; }
    return;
  }
  for (let index = 0; index < queue.length;) {
    const item = queue[index]!;
    const lease = tryPick(item.request);
    if (!lease) { index++; continue; }
    queue.splice(index, 1);
    if (item.timer) clearTimeout(item.timer);
    item.signal?.removeEventListener("abort", item.abort);
    item.resolve(lease);
  }
  if (drainTimer !== undefined) { clearTimeout(drainTimer); drainTimer = undefined; }
  if (!queue.length) return;
  // ACT: 全部 Key 都在 RPM 冷却时，等到最早一个名额释放再唤醒队列，避免空转轮询。
  const wait = nextWakeInMs();
  drainTimer = setTimeout(() => { drainTimer = undefined; drain(); }, Number.isFinite(wait) ? Math.min(wait + 20, windowMs + 50) : 1000);
  drainTimer.unref?.();
}

function failureReason(request: LeaseRequest) {
  const states = [...keys.values()];
  if (!states.length) return "请先在「设置 → 媒体模型 → Agnes AI」中填写 API Keys";
  const now = Date.now();
  const valid = states.filter(state => !state.invalid);
  if (!valid.length) return "所有 Agnes API Key 均已失效，请在媒体模型设置中更新";
  const quotaFull = valid.every(state => request.mediaType === "image"
    ? (dailyImageLimit() > 0 && state.imageCount >= dailyImageLimit())
    : (dailyVideoSecondLimit() > 0 && state.videoSeconds >= dailyVideoSecondLimit()));
  if (quotaFull) return "今日免费额度已用尽，额度将在次日 00:00 重置";
  const tier = tierOf(request.size);
  const limit = request.mediaType === "video" ? videoRpm : imageLimit(tier).rpm;
  const concurrency = request.mediaType === "video" ? videoConcurrency : imageLimit(tier).concurrency;
  // ACT: 区分「Key 都在跑任务」和「都在等 RPM 窗口」，两者的等待时间相差一个数量级。
  if (valid.every(state => state.inFlight >= concurrency)) return `所有 Agnes API Key 都在使用中（共 ${valid.length} 个），请等待当前任务完成`;
  if (request.mediaType === "video") return `所有 Agnes API Key 都在使用中（共 ${valid.length} 个），请等待当前任务完成`;
  const fastest = Math.min(...valid.map(state => windowResetInMs(state, request.mediaType, tier, limit, now)));
  return `所有 Agnes API Key 均已限流，预计 ${Math.max(1, Math.ceil(fastest / 1000))} 秒后恢复`;
}

export async function acquire(request: LeaseRequest): Promise<KeyLease> {
  await load();
  syncKeys();
  const lease = tryPick(request);
  if (lease) return lease;
  // ACT: 没有可用 Key 时先区分「等得到」和「等不到」，后者立即失败，不让用户白等两分钟。
  if (!keys.size || ![...keys.values()].some(state => !state.invalid)) throw new Error(failureReason(request));
  return new Promise<KeyLease>((resolve, reject) => {
    if (request.signal?.aborted) return reject(request.signal.reason);
    const item: QueueItem = {
      request, resolve, reject, signal: request.signal,
      abort: () => {
        const index = queue.indexOf(item);
        if (index >= 0) queue.splice(index, 1);
        if (item.timer) clearTimeout(item.timer);
        reject(request.signal?.reason);
      },
    };
    queue.push(item);
    request.signal?.addEventListener("abort", item.abort, { once: true });
    drain();
    // ACT: 队列最多等待两分钟；超出说明额度或限流无法在合理时间内恢复，直接给出原因。
    item.timer = setTimeout(() => {
      const index = queue.indexOf(item);
      if (index < 0) return;
      queue.splice(index, 1);
      request.signal?.removeEventListener("abort", item.abort);
      reject(new Error(failureReason(request)));
    }, windowMs * 2);
    item.timer.unref?.();
  });
}

export async function snapshot(): Promise<PoolSnapshot> {
  await load();
  syncKeys();
  const now = Date.now();
  const daily = dailyResetInMs();
  return {
    configured: keys.size > 0,
    queued: queue.length,
    remoteAssetCount: await remoteAssetCount(),
    dailyImageLimit: dailyImageLimit(),
    dailyVideoSecondLimit: dailyVideoSecondLimit(),
    limits: { imageRpm, imageConcurrency, videoRpm, videoConcurrency },
    keys: [...keys.values()].map(state => {
      const blockedTiers = ["1K", "2K", "3K", "4K"].filter(tier => windowResetInMs(state, "image", tier, imageRpm[tier]!, now) > 0);
      const videoBlocked = windowResetInMs(state, "video", "720P", videoRpm, now);
      const reset = Math.max(videoBlocked, ...blockedTiers.map(tier => windowResetInMs(state, "image", tier, imageRpm[tier]!, now)));
      return {
        id: state.id, label: state.label, masked: state.masked, inFlight: state.inFlight,
        imageCount: state.imageCount, videoSeconds: state.videoSeconds,
        rpmResetInMs: Number.isFinite(reset) ? reset : 0,
        blockedTiers: videoBlocked > 0 ? ["视频", ...blockedTiers] : blockedTiers,
        dailyResetInMs: daily,
        invalid: state.invalid, lastError: state.lastError,
        ...(state.progress === undefined ? {} : { progress: state.progress }),
      } satisfies KeySnapshot;
    }),
  };
}

export async function reset(id?: string) {
  await load();
  syncKeys();
  for (const state of keys.values()) {
    if (id && state.id !== id) continue;
    state.imageCount = 0;
    state.videoSeconds = 0;
    state.imageStamps = [];
    state.videoStamps = [];
    state.invalid = false;
    state.lastError = "";
  }
  scheduleSave();
  drain();
}
