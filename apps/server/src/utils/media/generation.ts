import { t, translateMessage } from "@/lib/i18n";
import { mkdir, readFile, realpath, stat, unlink } from "@toonflow/file";
import { join, relative } from "node:path";
import { mediaProviders, type Provider } from "@toonflow/providers";
import type { GeneratedMedia, MediaGenerationRequest, MediaModel, MediaReference } from "@toonflow/tools-scaffold/runtime";
import conf from "@/utils/conf";
import { getMediaProvider, listMediaProviders, loadMediaProviderSource } from "@/utils/media/provider";
import { lockWorkspaceFiles, resolveWorkspacePath, writeWorkspaceFile } from "@/utils/workspace/files";
import { beginGeneration, getProviderPrice } from "@/utils/media/billing";
import { detectMimeType, readPriceReference } from "@/utils/media/priceReference";
import { acquire } from "@/utils/media/keyPool";
import { remember as rememberRemoteAsset, resolve as resolveRemoteAsset } from "@/utils/media/remoteAssets";

const agnesProviderId = "agnes";

const maxMediaSize = 100 * 1024 * 1024;
const mediaExtensions: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "image/avif": "avif", "image/bmp": "bmp", "image/tiff": "tiff",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/ogg": "ogv",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "audio/webm": "webm",
  "audio/flac": "flac", "audio/aac": "aac", "audio/mp4": "m4a", "audio/opus": "opus", "audio/pcm": "pcm",
};

function invalid(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function imageOptions(value: unknown, pattern: RegExp) {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length <= 64 && item === item.trim() && pattern.test(item)))] : undefined;
}

export async function listMediaModels(): Promise<MediaModel[]> {
  const installedProviders = await listMediaProviders();
  // ACT: Agnes 为内置免费模型，排在最前，使新建节点默认选中它。
  const ordered = [...installedProviders].sort((left, right) => Number(right.id === agnesProviderId) - Number(left.id === agnesProviderId));
  return ordered.flatMap(provider => provider.models.flatMap(model => {
    if (model.type !== "image" && model.type !== "video" && model.type !== "audio") return [];
    const builtIn = (mediaProviders as readonly Provider[]).find(item => item.id === provider.id)?.models.find(item => item.id === model.id);
    return [{
      providerId: provider.id, providerLabel: provider.label, modelId: model.id, label: model.label, type: model.type,
      supportsPrice: "supportsPrice" in provider && provider.supportsPrice === true,
      rules: model.rules,
      mode: model.mode, durationResolutionMap: model.durationResolutionMap, audio: model.audio,
      ...(model.type === "audio" ? { voices: model.voices } : {}),
      ...(model.type === "image" ? {
        imageSizes: imageOptions(Array.isArray(model.imageSizes) ? model.imageSizes : builtIn?.imageSizes, /^[^\u0000-\u001f\u007f]+$/),
        imageRatios: imageOptions(Array.isArray(model.imageRatios) ? model.imageRatios : builtIn?.imageRatios, /^[1-9]\d{0,3}:[1-9]\d{0,3}$/),
      } : {}),
    } as MediaModel];
  }));
}

export async function readReference(cwd: string, reference: MediaReference, mediaType: string, signal?: AbortSignal): Promise<Extract<MediaInput, { type: "base64" }>> {
  signal?.throwIfAborted();
  const { path } = await resolveWorkspacePath(cwd, reference.path);
  const info = await stat(path);
  if (!info.isFile() || info.size > maxMediaSize) invalid("参考媒体须为不超过 100 MB 的文件");
  const bytes = await readFile(path, { signal });
  if (!bytes.length || bytes.length > maxMediaSize) invalid("参考媒体为空或超过 100 MB");
  const mimeType = detectMimeType(bytes, reference.mimeType);
  if (!mimeType.startsWith(`${mediaType}/`)) invalid(t`参考媒体类型须为 ${mediaType}`);
  return { type: "base64", data: bytes.toString("base64"), mimeType, name: reference.path };
}

async function downloadAsset(url: string, signal?: AbortSignal) {
  if (!/^https?:\/\//i.test(url)) invalid("生成结果必须使用 HTTP 或 HTTPS 地址");
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(t`下载生成结果失败（HTTP ${response.status}）`);
  if (Number(response.headers.get("content-length")) > maxMediaSize) {
    await response.body?.cancel();
    invalid("生成文件不能超过 100 MB");
  }
  const reader = response.body?.getReader();
  if (!reader) invalid("生成结果为空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxMediaSize) invalid("生成文件不能超过 100 MB");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return { bytes: Buffer.concat(chunks, size), mimeType: response.headers.get("content-type") ?? "" };
}

async function assetBytes(asset: MediaAsset, mediaType: "image" | "video" | "audio", signal?: AbortSignal) {
  if (!asset || asset.mediaType !== mediaType) invalid("供应商返回的媒体类型不正确");
  let bytes: Uint8Array;
  let mimeType = asset.mimeType ?? "";
  if (asset.type === "url") {
    const result = await downloadAsset(asset.url, signal);
    bytes = result.bytes;
    const responseMimeType = result.mimeType.split(";")[0].trim().toLowerCase();
    mimeType = responseMimeType && responseMimeType !== "application/octet-stream" ? result.mimeType : mimeType;
  } else if (asset.type === "base64") {
    const data = /^data:([^;,]+);base64,([\s\S]+)$/.exec(asset.data);
    const content = (data?.[2] ?? asset.data).replace(/\s/g, "");
    if (content.length > Math.ceil(maxMediaSize / 3) * 4 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(content) || content.length % 4 === 1) invalid("生成结果的 base64 内容无效或超过 100 MB");
    bytes = Buffer.from(content, "base64");
    mimeType = data?.[1] ?? mimeType;
  } else if (asset.type === "binary" && ArrayBuffer.isView(asset.data) && asset.data.BYTES_PER_ELEMENT === 1) {
    bytes = asset.data;
  } else { return invalid("供应商返回了无效的媒体结果"); }
  if (!bytes.byteLength || bytes.byteLength > maxMediaSize) invalid("生成文件为空或超过 100 MB");
  mimeType = detectMimeType(bytes, mimeType);
  if (!mimeType.startsWith(`${mediaType}/`) || !mediaExtensions[mimeType]) invalid("生成结果不是支持的图片、视频或音频格式");
  return { bytes, mimeType };
}

async function prepareRequest<T>(directory: string | undefined, mediaType: "image" | "video" | "audio", request: MediaGenerationRequest,
  read: (cwd: string, reference: MediaReference, type: string, signal?: AbortSignal) => Promise<T>, signal?: AbortSignal) {
  // ACT: 仅向已适配引用映射的内置供应商传递，其他第三方适配器仍接收原有公共参数。
  const referenceOrder = mediaType === "video" && ["tfRouter", "apiMart", "metaso", "compshare"].includes(request.providerId) ? request.referenceOrder : undefined;
  if (referenceOrder) {
    const media = { image: request.images, video: request.videos, audio: request.audios };
    for (const [index, reference] of referenceOrder.entries()) {
      const available = reference.type === "text" || ("index" in reference
        ? Number.isSafeInteger(reference.index) && reference.index >= 0 && !!media[reference.type]?.[reference.index]
        : !!request[reference.type]);
      if (!available) invalid(`参考 ${index + 1} 指向的素材不存在，请重新选择引用`);
    }
    for (const match of request.prompt.matchAll(/\{\{ref (\d+)\}\}/g)) {
      if (!referenceOrder[Number(match[1]) - 1]) invalid(`引用标记 ${match[0]} 没有对应素材，请重新选择引用`);
    }
  }
  const references = async (items: MediaReference[] | undefined, type: string) => {
    if (!items?.length) return items ? [] : undefined;
    if (!directory) invalid("参考媒体需要工作目录");
    // ACT: 单次请求顺序处理引用，避免数十个参考媒体同时启动探测进程。
    const result: T[] = [];
    for (const item of items) result.push(await read(directory, item, type, signal));
    return result;
  };
  const images = await references(request.images, "image");
  if (mediaType === "audio") return {
    type: "audio" as const, model: request.modelId, text: request.prompt, images, audios: await references(request.audios, "audio"), other: request.other,
    voice: request.voice, speed: request.speed, volume: request.volume, pitch: request.pitch, language: request.language, format: request.format, sampleRate: request.sampleRate,
  };
  if (mediaType === "image") return { type: "image" as const, model: request.modelId, prompt: request.prompt, images, ratio: request.ratio, size: request.size, other: request.other };
  return {
    type: "video" as const, model: request.modelId, prompt: request.prompt, images, other: request.other,
    ...(referenceOrder ? { referenceOrder } : {}),
    videos: await references(request.videos, "video"), audios: await references(request.audios, "audio"),
    firstFrame: (await references(request.firstFrame ? [request.firstFrame] : undefined, "image"))?.[0],
    lastFrame: (await references(request.lastFrame ? [request.lastFrame] : undefined, "image"))?.[0],
    ratio: request.ratio, resolution: request.resolution, duration: request.duration, generateAudio: request.generateAudio, mode: request.mode,
  };
}

async function configuredProvider(request: MediaGenerationRequest, mediaType: "image" | "video" | "audio", signal?: AbortSignal, directory?: string, options: { config?: Record<string, unknown>; fetchRequest?: typeof fetch } = {}) {
  const info = await getMediaProvider(request.providerId);
  if (!info.models.some(model => model.id === request.modelId && model.type === mediaType)) invalid("所选媒体模型不存在或类型不匹配，请重新选择");
  const configurations = record(conf.get("settings", {}).mediaProviderConfigs);
  const config = options.config ? { ...record(configurations[info.id]), ...options.config } : record(configurations[info.id]);
  return loadMediaProviderSource(info.source, config, signal, options.fetchRequest, directory);
}

async function preparePriceRequest(directory: string | undefined, mediaType: "image" | "video" | "audio", request: MediaGenerationRequest, signal?: AbortSignal) {
  const deadline = AbortSignal.timeout(5000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const prepared = await prepareRequest(directory, mediaType, request, readPriceReference, combined);
    if (prepared.type === "video") delete prepared.referenceOrder;
    return prepared;
  }
  catch (error) {
    signal?.throwIfAborted();
    if (deadline.aborted) throw new Error("读取参考媒体信息超时，请稍后重试");
    throw error;
  }
}

export async function getMediaPrice(directory: string | undefined, mediaType: "image" | "video" | "audio", request: MediaGenerationRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const provider = await configuredProvider(request, mediaType, signal, directory);
  if (!provider.getPrice) return null;
  const prepared = await preparePriceRequest(directory, mediaType, request, signal);
  signal?.throwIfAborted();
  return getProviderPrice(provider, prepared);
}

/** prepareRequest 的输出：保留媒体类型标记，供生成函数收窄参数。 */
type PreparedRequest =
  | ({ type: "image" } & ImageRequest)
  | ({ type: "video" } & VideoRequest)
  | ({ type: "audio" } & AudioRequest);

/**
 * 参考素材转公网地址：优先复用该文件此前由 Agnes 返回、且探活仍有效的 URL；
 * 没有记录或已失效时保留原始内容，由供应商决定是否接受 Base64。
 */
async function exposeReference(directory: string, reference: MediaReference, input: MediaInput): Promise<MediaInput> {
  const remote = await resolveRemoteAsset(directory, reference.path).catch(() => undefined);
  return remote ? { type: "url", url: remote, ...(input.mimeType ? { mimeType: input.mimeType } : {}) } : input;
}

/**
 * 把请求中的参考素材换成公网地址。paths 与 images/audios 数组下标一一对应，
 * firstFrame、lastFrame 各取 paths.firstFrame / paths.lastFrame。
 */
async function exposeReferences<T extends PreparedRequest>(
  directory: string,
  request: T,
  paths: { images?: string[]; audios?: string[]; firstFrame?: string; lastFrame?: string },
): Promise<T> {
  const next = { ...request } as ImageRequest & VideoRequest & AudioRequest;
  const swap = async (items: MediaInput[] | undefined, sources: string[] | undefined) => {
    if (!items?.length) return items;
    const result: MediaInput[] = [];
    for (const [index, item] of items.entries()) {
      const source = sources?.[index];
      result.push(source ? await exposeReference(directory, { path: source, mimeType: item.mimeType ?? "application/octet-stream" }, item) : item);
    }
    return result;
  };
  if (next.images) next.images = await swap(next.images, paths.images);
  if (next.audios) next.audios = await swap(next.audios, paths.audios);
  if (next.firstFrame) next.firstFrame = await exposeReference(directory, { path: paths.firstFrame ?? "", mimeType: next.firstFrame.mimeType ?? "image/png" }, next.firstFrame);
  if (next.lastFrame) next.lastFrame = await exposeReference(directory, { path: paths.lastFrame ?? "", mimeType: next.lastFrame.mimeType ?? "image/png" }, next.lastFrame);
  return next as T;
}

export async function generateMedia(
  cwd: string,
  mediaType: "image" | "video" | "audio",
  request: MediaGenerationRequest,
  signal?: AbortSignal,
): Promise<GeneratedMedia[]> {
  signal?.throwIfAborted();
  if (!request.prompt.trim()) invalid("请输入生成提示词");
  const directory = await realpath(cwd);
  const outputDirectory = request.outputDirectory ?? "assets/generated";
  await resolveWorkspacePath(directory, outputDirectory, true);
  if (request.providerId !== agnesProviderId) {
    const provider = await configuredProvider(request, mediaType, signal, directory);
    const generate = mediaType === "image" ? provider.generateImage : mediaType === "video" ? provider.generateVideo : provider.generateAudio;
    if (typeof generate !== "function") invalid(t`此供应商不支持${translateMessage({ image: "图片", video: "视频", audio: "音频" }[mediaType])}生成`);
    const rules = Array.isArray(provider.rules) ? provider.rules : [];
    if (rules.some(rule => rule.field === "apiKey") && (typeof provider.config.apiKey !== "string" || !provider.config.apiKey.trim())) invalid("请先在媒体模型设置中配置供应商 API Key");
    const prepared = await prepareRequest(directory, mediaType, request, readReference, signal);
    signal?.throwIfAborted();
    return runGeneration(directory, outputDirectory, mediaType, prepared, provider, signal);
  }
  const prepared = await prepareRequest(directory, mediaType, request, readReference, signal);
  signal?.throwIfAborted();
  return generateWithKeyPool(directory, outputDirectory, mediaType, request, prepared, signal);
}

/**
 * Agnes 多 Key 并发：每个任务先向 Key 池申请一个空闲槽位，槽位不同即并行执行。
 * 429 释放槽位并换 Key 重试；其他错误直接抛出，避免重复提交产生费用。
 */
/** 队列满时的退避等待，可被取消信号打断。 */
function waitBeforeRetry(ms: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function generateWithKeyPool(
  directory: string,
  outputDirectory: string,
  mediaType: "image" | "video" | "audio",
  request: MediaGenerationRequest,
  prepared: PreparedRequest,
  signal?: AbortSignal,
): Promise<GeneratedMedia[]> {
  if (mediaType === "audio") invalid("Agnes 不支持音频生成");
  // ACT: 参考素材的本地路径取自原始请求，用于复用供应商此前返回的公网地址。
  const exposed = await exposeReferences(directory, prepared, {
    images: request.images?.map(item => item.path),
    audios: request.audios?.map(item => item.path),
    firstFrame: request.firstFrame?.path,
    lastFrame: request.lastFrame?.path,
  });
  const videoSeconds = mediaType === "video" ? Number((exposed as VideoRequest).duration ?? 5) : 0;
  // ACT: 429 换 Key 有上限；503 队列满是平台级拥堵，按总时限持续退避，避免过早失败。
  const maxKeySwitches = 3;
  const queueDeadline = Date.now() + 8 * 60_000;
  let keySwitches = 0;
  let lastError: unknown;
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const lease = await acquire({ mediaType, size: (exposed as ImageRequest).size, videoSeconds, signal });
    let rejected = false;
    let queueFull = false;
    // ACT: 429 由供应商以 status 抛出；换 Key 立即重试，不占用同一 Key 的窗口名额。
    // ACT: 503 video/image_queue_full 是平台级全局排队，与 Key 无关，换 Key 无用，需退避后重试。
    // ACT: 同时旁路读取视频轮询响应里的 progress，供悬浮窗展示，不改变供应商的响应对象。
    const fetchRequest: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const response = await fetch(input, init);
      if (response.status === 429) rejected = true;
      if (response.status === 503) queueFull = true;
      if (mediaType === "video" && response.ok) {
        response.clone().json().then((body: unknown) => {
          const progress = (body as { progress?: unknown } | null)?.progress;
          if (typeof progress === "number" && Number.isFinite(progress)) lease.progress(progress);
        }).catch(() => {});
      }
      return response;
    }, { preconnect: fetch.preconnect });
    const provider = await configuredProvider(request, mediaType, signal, directory, { config: { apiKey: lease.key }, fetchRequest });
    try {
      const files = await runGeneration(directory, outputDirectory, mediaType, exposed, provider, signal);
      lease.succeed({ videoSeconds });
      return files;
    } catch (error) {
      const retryable = lease.fail(error) || rejected;
      lastError = error;
      if (signal?.aborted) throw error;
      // ACT: 平台队列满时保留 Key 占用，退避后再试；此时换 Key 无意义，也不该判失败。
      if (queueFull && Date.now() < queueDeadline) {
        await waitBeforeRetry(Math.min(2 ** attempt * 5000, 30000), signal);
        continue;
      }
      if (queueFull) throw new Error("Agnes 队列持续拥堵，已重试 8 分钟仍未成功，请稍后重试");
      if (!retryable) throw error;
      if (++keySwitches >= maxKeySwitches) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Agnes 生成失败，请稍后重试");
}

async function runGeneration(
  directory: string,
  outputDirectory: string,
  mediaType: "image" | "video" | "audio",
  prepared: PreparedRequest,
  provider: Awaited<ReturnType<typeof configuredProvider>>,
  signal?: AbortSignal,
): Promise<GeneratedMedia[]> {
  const finish = beginGeneration(provider);
  const written: string[] = [];
  const result: GeneratedMedia[] = [];
  try {
    signal?.throwIfAborted();
    const { type, ...parameters } = prepared;
    const assets = type === "audio" ? await provider.generateAudio!(parameters as AudioRequest)
      : type === "image" ? await provider.generateImage!(parameters as ImageRequest) : await provider.generateVideo!(parameters as VideoRequest);
    if (!Array.isArray(assets) || !assets.length) invalid("供应商未返回生成结果");
    for (const asset of assets) {
      signal?.throwIfAborted();
      const { bytes, mimeType } = await assetBytes(asset, mediaType, signal);
      signal?.throwIfAborted();
      const output = await resolveWorkspacePath(directory, outputDirectory, true);
      const release = lockWorkspaceFiles([output.path]);
      try {
        await mkdir(output.path, { recursive: true });
        const file = join(outputDirectory, `${mediaType}${crypto.randomUUID()}.${mediaExtensions[mimeType]}`);
        const { path } = await resolveWorkspacePath(directory, file);
        signal?.throwIfAborted();
        await writeWorkspaceFile(path, bytes, true);
        written.push(path);
        const outputPath = relative(directory, path).replace(/\\/g, "/");
        // ACT: 供应商直接给出公网 URL 时记下文件与地址的对应关系，后续可作参考素材复用。
        if (asset.type === "url" && /^https?:\/\//i.test(asset.url)) rememberRemoteAsset(directory, outputPath, asset.url, provider.id);
        result.push({ path: outputPath, mimeType, mediaType });
      } finally { release(); }
    }
    signal?.throwIfAborted();
    return result;
  } catch (err) {
    // ACT: 只回滚本次创建的文件，保留目录中已有的节点资源。
    await Promise.all(written.map(path => unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; })));
    throw err;
  } finally { finish(); }
}
