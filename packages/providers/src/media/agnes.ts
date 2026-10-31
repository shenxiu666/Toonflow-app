const rules = [
  {
    type: "input",
    field: "apiKeys" as const,
    title: "API Keys",
    value: "",
    props: { type: "textarea", rows: 6, placeholder: "每行一个 API Key，可导入多个账号的 Key 并发使用" },
  },
  {
    type: "inputNumber",
    field: "dailyImageLimit" as const,
    title: "每 Key 每日图片上限",
    value: 0,
    props: { min: 0, step: 10, placeholder: "0 表示不限" },
  },
  {
    type: "inputNumber",
    field: "dailyVideoSecondLimit" as const,
    title: "每 Key 每日视频秒数上限",
    value: 0,
    props: { min: 0, step: 10, placeholder: "0 表示不限" },
  },
] as const;

const version = "2.0.0";
const apiUrl = "https://apihub.agnes-ai.com";
const imageModel = "agnes-image-2.5-flash";
const videoModel = "agnes-video-2.5-flash";

type ReferencedVideoRequest = VideoRequest & {
  referenceOrder?: ({ type: "image" | "video" | "audio"; index: number } | { type: "firstFrame" | "lastFrame" | "text" })[];
};

function mediaUrl(input: MediaInput) {
  if (input.type === "url") {
    if (!/^https?:\/\//i.test(input.url)) throw new Error("参考媒体需要 HTTP 或 HTTPS 地址");
    return input.url;
  }
  const data = input.type === "binary" ? Buffer.from(input.data).toString("base64") : input.data;
  return data.startsWith("data:") ? data : `data:${input.mimeType};base64,${data}`;
}

function apiKey(config: Record<string, unknown>) {
  const value = typeof config.apiKey === "string" ? config.apiKey.trim().replace(/^Bearer\s+/i, "").trim() : "";
  if (!value) throw new Error("请先在媒体模型设置中配置 Agnes API Keys");
  return value;
}

function wait(signal: AbortSignal, ms: number) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** 把节点传出的精确尺寸归一为文档要求的档位；未知值按最长边映射到最近的档位。 */
function imageSize(value: string | undefined) {
  const raw = (value ?? "").trim().toUpperCase();
  if (["1K", "2K", "3K", "4K"].includes(raw)) return raw;
  const exact = /^(\d+)\s*[X×]\s*(\d+)$/.exec(raw);
  if (exact) {
    const longest = Math.max(Number(exact[1]), Number(exact[2]));
    if (longest >= 3600) return "4K";
    if (longest >= 2800) return "3K";
    if (longest >= 1800) return "2K";
    return "1K";
  }
  return "2K";
}

const imageRatios = ["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"];
const videoRatios = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
const frameModes = ["startEndRequired", "endFrameOptional", "startFrameOptional", "singleImage"];

function imageRatio(value: string | undefined) {
  return value && imageRatios.includes(value) ? value : "1:1";
}

function videoRatio(value: string | undefined) {
  return value && videoRatios.includes(value) ? value : "16:9";
}

function videoSeconds(value: number | undefined) {
  const seconds = Number.isFinite(value) ? Math.round(value as number) : 5;
  return String(Math.min(12, Math.max(4, seconds)));
}

function videoPrompt(request: ReferencedVideoRequest, mode: VideoMode) {
  const isFrames = frameModes.includes(String(mode));
  return request.prompt.replace(/\{\{ref (\d+)\}\}/g, (marker, number: string) => {
    const reference = request.referenceOrder?.[Number(number) - 1];
    if (!reference) throw new Error(`引用标记 ${marker} 缺少素材映射，请更新视频节点或提供 referenceOrder`);
    if (reference.type === "text") return `参考 ${Number(number)}`;
    if (reference.type === "firstFrame" || reference.type === "lastFrame") {
      if (!isFrames || !request[reference.type]) throw new Error(`引用标记 ${marker} 对应的首尾帧未提交`);
      return reference.type === "firstFrame" ? "首帧" : "尾帧";
    }
    if (!("index" in reference)) throw new Error(`引用标记 ${marker} 的素材类型无效`);
    if (!Number.isSafeInteger(reference.index) || reference.index < 0) throw new Error(`引用标记 ${marker} 的素材序号无效`);
    if (isFrames && reference.type === "image") {
      if (!request.images?.[reference.index]) throw new Error(`引用标记 ${marker} 对应的素材未提交，请重新选择引用`);
      return reference.index === 0 ? "首帧" : "尾帧";
    }
    const media = { image: request.images, video: request.videos, audio: request.audios };
    if (!Array.isArray(mode) || !media[reference.type]?.[reference.index]) {
      throw new Error(`引用标记 ${marker} 对应的素材未提交，请重新选择引用`);
    }
    // Agnes 的 <Picture N>、<Audio N> 按各自数组独立从 1 编号。
    const labels = { image: "Picture", video: "Video", audio: "Audio" };
    return `<${labels[reference.type]} ${reference.index + 1}>`;
  });
}

function statusError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

async function readError(response: Response, context: ProviderContext) {
  const text = await response.text().catch(() => "");
  let detail = "";
  try {
    detail = context.tool.errorMessage(JSON.parse(text));
  } catch {
    detail = context.tool.errorMessage(text);
  }
  return detail;
}

function firstImage(body: unknown): MediaAsset[] {
  if (!body || typeof body !== "object") throw new Error("Agnes 响应格式错误");
  const data = (body as Record<string, unknown>).data;
  if (!Array.isArray(data) || !data.length) throw new Error("Agnes 未返回生成结果");
  const item = data[0];
  if (!item || typeof item !== "object") throw new Error("Agnes 未返回生成结果");
  const value = item as Record<string, unknown>;
  const url = typeof value.url === "string" ? value.url.trim() : "";
  if (url) return [{ mediaType: "image", type: "url", url }];
  const base64 = typeof value.b64_json === "string" ? value.b64_json.trim() : "";
  if (base64) return [{ mediaType: "image", type: "base64", mimeType: "image/png", data: base64 }];
  throw new Error("Agnes 未返回图片地址或 Base64 内容");
}

export default {
  id: "agnes" as const,
  label: "Agnes AI",
  icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJnIiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+PHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjN0M1Q0ZGIi8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjMjJEM0VFIi8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iOSIgZmlsbD0idXJsKCNnKSIvPjxwYXRoIGQ9Ik05LjUgMjMuNSAxNiA4LjVsNi41IDE1aC0zLjRsLTEuMi0zaC0zLjhsLTEuMiAzeiIgZmlsbD0iI2ZmZiIvPjwvc3ZnPg==",
  version,
  apiUrl,
  readme: "## Agnes AI\n\n内置 `Agnes Image 2.5 Flash` 与 `Agnes Video 2.5 Flash`，当前为限时免费体验价。\n\n**多个 API Key 会并发调度**：每个 Key 独立计算限流与用量，Key 越多出图、出视频越快。每行填写一个 Key 即可。\n\n视频参考素材会自动复用 Agnes 生图返回的公网地址，无需额外配置。\n\n免费用户限流：视频 1 次/分钟；图片 1K 20 次/分钟、2K 10 次/分钟、3K/4K 1 次/分钟。\n\n[前往 Agnes 平台获取 Key](https://platform.agnes-ai.com/)",
  rules,
  models: [
    {
      id: "agnes-image-2.5-flash",
      label: "Agnes Image 2.5 Flash",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["1K", "2K", "3K", "4K"],
      imageRatios: ["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"],
    },
    {
      id: "agnes-video-2.5-flash",
      label: "Agnes Video 2.5 Flash",
      type: "video",
      mode: ["text", "startFrameOptional", "endFrameOptional", "startEndRequired", ["imageReference:5", "audioReference:3"]],
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12], resolution: ["720P"] }],
    },
  ] satisfies ProviderModel[],
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    const key = apiKey(this.config);
    const images = (request.images ?? []).map(mediaUrl);
    const body = {
      model: request.model,
      prompt: request.prompt,
      size: imageSize(request.size),
      ratio: imageRatio(request.ratio),
      // ACT: 文档要求 response_format 只能放在 extra_body 内，放在顶层会被拒绝。
      extra_body: { response_format: "url", ...(images.length ? { image: images } : {}) },
    };
    // ACT: 官方建议客户端超时 60-360 秒；高分辨率图片可能接近上限。
    const signal = AbortSignal.any([AbortSignal.timeout(360_000), ...(this.signal ? [this.signal] : [])]);
    const response = await this.tool.fetch(`${apiUrl}/v1/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const detail = await readError(response, this);
      throw statusError(response.status, detail || `Agnes 图片生成失败（HTTP ${response.status}）`);
    }
    return firstImage(await response.json());
  },
  async generateVideo(request: ReferencedVideoRequest): Promise<MediaAsset[]> {
    const key = apiKey(this.config);
    const images = (request.images ?? []).map(mediaUrl);
    const audios = (request.audios ?? []).map(mediaUrl);
    const mode = request.mode ?? (request.firstFrame || request.lastFrame ? "startFrameOptional" : images.length ? "singleImage" : "text");
    const isFrames = frameModes.includes(String(mode));
    const isReference = Array.isArray(mode);
    if (request.videos?.length) throw new Error("Agnes Video 2.5 Flash 不支持参考视频");
    if (isReference && images.length > 5) throw new Error("Agnes Video 2.5 Flash 参考图片最多 5 张");
    if (isReference && audios.length > 3) throw new Error("Agnes Video 2.5 Flash 参考音频最多 3 段");
    if (isFrames && !request.firstFrame && !request.lastFrame && !images.length) throw new Error("首尾帧模式至少需要提供一张图片");

    const body: Record<string, unknown> = {
      model: request.model,
      prompt: videoPrompt(request, mode),
      seconds: videoSeconds(request.duration),
      // ACT: Flash 仅支持 720P，传其他值会被 HTTP 400 拒绝。
      size: "720P",
      aspect_ratio: videoRatio(request.ratio),
      n: 1,
    };
    if (isFrames) {
      // ACT: 单图参考没有独立首帧字段，按首帧提交以尽量保留原图构图。
      const first = request.firstFrame ?? (mode === "singleImage" ? request.images?.[0] : undefined);
      body.mode = "keyframe";
      if (first) body.first_frame = mediaUrl(first);
      if (request.lastFrame) body.last_frame = mediaUrl(request.lastFrame);
    } else if (isReference) {
      body.mode = "reference";
      if (images.length) body.images = images;
      if (audios.length) body.audios = audios;
    } else {
      body.mode = "text";
    }

    // ACT: 单次生成最多等待 30 分钟；轮询全程复用同一 Key，宿主不会在任务中途换 Key。
    const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const created = await this.tool.fetch(`${apiUrl}/v1/videos`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!created.ok) {
      const detail = await readError(created, this);
      throw statusError(created.status, detail || `Agnes 视频任务创建失败（HTTP ${created.status}）`);
    }
    const task = (await created.json()) as Record<string, unknown>;
    const videoId = typeof task.video_id === "string" ? task.video_id.trim() : "";
    if (!videoId) throw new Error("Agnes 未返回 video_id");

    while (true) {
      await wait(signal, 1500);
      const url = new URL(`${apiUrl}/agnesapi`);
      url.searchParams.set("video_id", videoId);
      url.searchParams.set("model_name", request.model);
      const polled = await this.tool.fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal });
      if (!polled.ok) {
        const detail = await readError(polled, this);
        throw statusError(polled.status, detail || `Agnes 视频任务查询失败（HTTP ${polled.status}）`);
      }
      const result = (await polled.json()) as Record<string, unknown>;
      const status = String(result.status ?? "").toLowerCase();
      if (status === "completed") {
        const videoUrl = typeof result.url === "string" ? result.url.trim() : "";
        if (!videoUrl) throw new Error("Agnes 视频已完成但未返回地址");
        return [{ mediaType: "video", type: "url", url: videoUrl }];
      }
      if (status === "failed") throw new Error(this.tool.errorMessage(result.error) || "Agnes 视频生成失败");
    }
  },
  async getPrice(): Promise<ProviderPrice> {
    return { price: "限时免费", tips: "Agnes 体验价 $0，官方可能随时调整" };
  },
} satisfies ProviderDefinition<typeof rules>;
