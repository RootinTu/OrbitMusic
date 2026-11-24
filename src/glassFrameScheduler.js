/**
 * WebGPU 全场景玻璃帧调度器：
 * - 活跃播放、用户交互宽限期内或表面结构变更时保持全速帧率；
 * - 音乐桥等不透明模态弹窗覆盖屏幕时暂停后台重绘；
 * - 静止待机态自动降频至 idleIntervalMs（约 8fps），显著降低闲置 GPU 纹理拷贝与着色器开销。
 */
export function createGlassFrameScheduler({
  idleIntervalMs = 125,
  interactionGraceMs = 700,
} = {}) {
  let lastRenderTime = -Infinity;
  let lastActivityTime = -Infinity;
  let dirty = true;

  return {
    markDirty(now = 0) {
      dirty = true;
      if (Number.isFinite(now)) lastActivityTime = Math.max(lastActivityTime, now);
    },
    markActivity(now) {
      if (Number.isFinite(now)) lastActivityTime = Math.max(lastActivityTime, now);
    },
    shouldRender(now, {
      hidden = false,
      inFlight = false,
      paused = false,
      active = false,
      hasPendingSurfaces = false,
      initialized = false,
    } = {}) {
      if (hidden || inFlight) return false;
      if (paused && initialized && !dirty && !hasPendingSurfaces) return false;
      if (!initialized || dirty || hasPendingSurfaces || active) return true;
      if (now - lastActivityTime <= interactionGraceMs) return true;
      return now - lastRenderTime >= idleIntervalMs;
    },
    markRendered(now) {
      lastRenderTime = now;
      dirty = false;
    },
  };
}
