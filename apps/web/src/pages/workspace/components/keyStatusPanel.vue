<template>
  <el-popover
    v-model:visible="visible"
    placement="top-end"
    trigger="click"
    :width="popoverWidth"
    :showArrow="false"
    :teleported="true"
    :popperStyle="{ padding: 0 }"
    @show="startPolling"
    @hide="stopPolling">
    <template #reference>
      <el-badge :value="activeCount" :hidden="!activeCount" :max="99" class="keyBadge">
        <el-button class="keyButton" :aria-label="`Agnes Key 状态，${activeCount} 个使用中`" :aria-expanded="visible">
          <icon-key :size="17" aria-hidden="true" />
        </el-button>
      </el-badge>
    </template>
    <section class="keyPanel" aria-label="Agnes Key 使用情况">
      <header class="panelHeader">
        <div class="panelTitle">
          <strong>Agnes Key</strong>
          <el-text size="small" type="info">共 {{ snapshot.keys.length }} 个 · 使用中 {{ activeCount }}<template v-if="snapshot.queued"> · 排队 {{ snapshot.queued }}</template></el-text>
          <el-text v-if="snapshot.remoteAssetCount" size="small" type="info">{{ snapshot.remoteAssetCount }} 个素材可直接复用公网地址</el-text>
        </div>
        <el-button text circle :icon="IconRefresh" :loading="loading" aria-label="刷新" @click="load" />
      </header>
      <el-alert v-if="errorMessage" class="panelAlert" :title="errorMessage" type="error" :closable="false" showIcon />
      <el-empty v-if="!snapshot.configured && !errorMessage" class="panelEmpty" :imageSize="56" description="尚未配置 API Keys">
        <el-text size="small" type="info">请在「设置 → 媒体模型 → Agnes AI」中填写</el-text>
      </el-empty>
      <el-scrollbar v-else-if="snapshot.keys.length" maxHeight="min(52dvh, 420px)">
        <ul class="keyList">
          <li v-for="item in snapshot.keys" :key="item.id" class="keyItem">
            <div class="keyHead">
              <span class="keyLabel">{{ item.label }}</span>
              <el-tag class="keyState" size="small" :type="stateType(item)" effect="plain">{{ stateText(item) }}</el-tag>
            </div>
            <el-text class="keyMask" size="small" type="info">{{ item.masked }}</el-text>
            <el-progress
              v-if="item.inFlight > 0 && item.progress !== undefined"
              class="keyProgress"
              :percentage="item.progress"
              :strokeWidth="4"
              :showText="false"
              :aria-label="`视频生成进度 ${item.progress}%`" />
            <dl class="keyMetrics">
              <div class="metric">
                <dt>图片</dt>
                <dd>{{ item.imageCount }} 张</dd>
              </div>
              <div class="metric">
                <dt>视频</dt>
                <dd>{{ item.videoSeconds }} 秒</dd>
              </div>
              <div class="metric">
                <dt>限流恢复</dt>
                <dd>{{ remaining(item.rpmResetInMs, sampledAt) > 0 ? formatDuration(remaining(item.rpmResetInMs, sampledAt)) : "—" }}</dd>
              </div>
              <div class="metric">
                <dt>额度重置</dt>
                <dd>{{ formatDuration(remaining(item.dailyResetInMs, sampledAt)) }}</dd>
              </div>
            </dl>
            <el-text v-if="item.invalid && item.lastError" class="keyError" size="small" type="danger">{{ item.lastError }}</el-text>
          </li>
        </ul>
      </el-scrollbar>
    </section>
  </el-popover>
</template>

<script setup lang="ts">
import axios from "axios";
import { computed, onBeforeUnmount, onScopeDispose, ref } from "vue";
import { ElButton, ElBadge, ElPopover, ElTag, ElText, ElAlert, ElEmpty, ElScrollbar, ElProgress } from "element-plus";
import { IconKey, IconRefresh } from "@tabler/icons-vue";

type KeySnapshot = {
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

type PoolSnapshot = {
  configured: boolean;
  queued: number;
  remoteAssetCount: number;
  dailyImageLimit: number;
  dailyVideoSecondLimit: number;
  keys: KeySnapshot[];
};

const visible = ref(false);
const loading = ref(false);
const errorMessage = ref("");
const snapshot = ref<PoolSnapshot>({ configured: false, queued: 0, remoteAssetCount: 0, dailyImageLimit: 0, dailyVideoSecondLimit: 0, keys: [] });
const now = ref(Date.now());
const popoverWidth = "min(400px, calc(100vw - 24px))";
const activeCount = computed(() => snapshot.value.keys.filter(item => item.inFlight > 0).length);
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let tickTimer: ReturnType<typeof setInterval> | undefined;
let request: AbortController | undefined;
let disposed = false;

function formatDuration(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours} 小时 ${minutes} 分`;
  if (minutes) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

/** 倒计时在本地递减，避免每秒请求服务端。 */
function remaining(ms: number, sampledAt: number) {
  return Math.max(0, ms - (now.value - sampledAt));
}

const sampledAt = ref(Date.now());

function stateType(item: KeySnapshot) {
  if (item.invalid) return "danger";
  if (item.inFlight > 0) return "success";
  if (remaining(item.rpmResetInMs, sampledAt.value) > 0) return "warning";
  return "info";
}

function stateText(item: KeySnapshot) {
  if (item.invalid) return "已失效";
  // ACT: 视频任务进行中即「使用中」；任务出结果后立即释放，不等 RPM 窗口。
  if (item.inFlight > 0) {
    const progress = item.progress === undefined ? "" : ` ${item.progress}%`;
    return `使用中${progress}${item.inFlight > 1 ? ` ×${item.inFlight}` : ""}`;
  }
  const reset = remaining(item.rpmResetInMs, sampledAt.value);
  if (reset > 0) return `限流中 ${Math.ceil(reset / 1000)}s`;
  return "空闲";
}

async function load() {
  if (disposed) return;
  request?.abort();
  const controller = new AbortController();
  request = controller;
  loading.value = true;
  try {
    const { data } = await axios.get<{ code: number; data: PoolSnapshot; message: string }>("/api/ai/media/agnesKeys", {
      signal: controller.signal, headers: { "x-toonflow-workspace": "1" }, timeout: 15000,
    });
    if (data.code !== 200 || !data.data) throw new Error(data.message || "读取 Key 状态失败");
    snapshot.value = data.data;
    sampledAt.value = Date.now();
    now.value = sampledAt.value;
    errorMessage.value = "";
  } catch (error) {
    if (!controller.signal.aborted) errorMessage.value = axios.isAxiosError(error) ? error.response?.data?.message || error.message : error instanceof Error ? error.message : "读取 Key 状态失败";
  } finally {
    if (request === controller) { request = undefined; loading.value = false; }
  }
}

function schedule() {
  clearTimeout(pollTimer);
  if (!visible.value || disposed) return;
  pollTimer = setTimeout(async () => {
    if (document.visibilityState === "visible") await load();
    schedule();
  }, 3000);
}

function startPolling() {
  void load();
  schedule();
  clearInterval(tickTimer);
  tickTimer = setInterval(() => { now.value = Date.now(); }, 1000);
}

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = undefined;
  clearInterval(tickTimer);
  tickTimer = undefined;
}

onBeforeUnmount(stopPolling);
onScopeDispose(() => {
  disposed = true;
  stopPolling();
  request?.abort();
});
</script>

<style lang="scss" scoped>
.keyBadge {
  :deep(.el-badge__content) {
    border: none;
  }
}

.keyButton {
  width: 34px;
  height: 34px;
  margin: 0;
  padding: 0;
  border-radius: 50%;
  border: 1px solid var(--el-border-color-light);
  background: var(--el-bg-color-overlay);
  box-shadow: inset 0 1px 0 #ffffff52;
  color: var(--el-text-color-regular);

  &:hover {
    color: var(--el-color-primary);
    border-color: color-mix(in srgb, var(--el-color-primary) 45%, var(--el-border-color-light));
  }

  &:focus-visible {
    outline: 2px solid var(--el-color-primary);
    outline-offset: 3px;
  }
}

.keyPanel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;

  .panelHeader {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .panelTitle {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .panelAlert {
    padding: 8px 10px;
  }

  .panelEmpty {
    padding: 8px 0;
  }

  .keyList {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 0;
    padding: 0 4px 0 0;
    list-style: none;
  }

  .keyItem {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
    border: 1px solid var(--el-border-color-lighter);
    border-radius: var(--el-border-radius-base);
    background: var(--el-fill-color-lighter);
  }

  .keyHead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;

    .keyLabel {
      font-weight: 600;
      font-size: 13px;
    }

    .keyState {
      flex-shrink: 0;
      font-variant-numeric: tabular-nums;
    }
  }

  .keyMask {
    font-family: ui-monospace, Consolas, monospace;
  }

  .keyProgress {
    margin: 2px 0;
  }

  .keyMetrics {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px 12px;
    margin: 0;

    .metric {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;

      dt {
        color: var(--el-text-color-secondary);
        font-size: 12px;
        white-space: nowrap;
      }

      dd {
        margin: 0;
        font-size: 12px;
        font-variant-numeric: tabular-nums;
        overflow-wrap: anywhere;
      }
    }
  }

  .keyError {
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
}
</style>
