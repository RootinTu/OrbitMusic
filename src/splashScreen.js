export const SPLASH_MIN_DISPLAY_MS = 1850;
export const SPLASH_REDUCED_DISPLAY_MS = 220;
export const SPLASH_EXIT_MS = 580;
export const SPLASH_VISIBILITY_FALLBACK_MS = 1200;

/**
 * 协调 index.html 内联开屏层（#orbit-splash）的播放与退场：
 * - 避免 Electron 窗口在 show:false 隐藏加载阶段把开屏动画提前消耗掉（「一闪而过」）：
 *   初始停在第 0 帧（data-state="waiting"），确认窗口真正显示到屏幕后再开始播放并从 0 计时；
 * - 播满 minDisplayMs 后自动雾化淡出并彻底移除 DOM 与内联样式；
 * - 支持任意点击或按键即时跳过，并自动适配 prefers-reduced-motion。
 */
export function scheduleOrbitSplashDismiss({
  documentRef = typeof document !== 'undefined' ? document : null,
  windowRef = typeof window !== 'undefined' ? window : null,
  minDisplayMs = SPLASH_MIN_DISPLAY_MS,
  reducedDisplayMs = SPLASH_REDUCED_DISPLAY_MS,
  exitMs = SPLASH_EXIT_MS,
  visibilityFallbackMs = SPLASH_VISIBILITY_FALLBACK_MS,
  setTimer = (fn, delay) => setTimeout(fn, delay),
  clearTimer = id => clearTimeout(id),
  requestFrame = fn => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimer(fn, 16)),
} = {}) {
  const splash = documentRef?.getElementById?.('orbit-splash');
  if (!splash) return { dismissNow: () => {}, cancel: () => {} };

  const reduced = Boolean(windowRef?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  const displayMs = reduced ? reducedDisplayMs : minDisplayMs;

  let started = false;
  let dismissed = false;
  let removed = false;
  let waitTimer = null;
  let removeTimer = null;
  let fallbackTimer = null;
  let sparkTimer = null;
  let offWindowShown = null;

  const clearPendingTimers = () => {
    for (const id of [waitTimer, removeTimer, fallbackTimer, sparkTimer]) {
      if (id !== null) clearTimer(id);
    }
    waitTimer = removeTimer = fallbackTimer = sparkTimer = null;
  };

  const cleanupListeners = () => {
    splash.removeEventListener?.('pointerdown', onSkip);
    windowRef?.removeEventListener?.('keydown', onSkip);
    documentRef?.removeEventListener?.('visibilitychange', onVisibilityChange);
    offWindowShown?.();
    offWindowShown = null;
  };

  const removeNodes = () => {
    if (removed) return;
    removed = true;
    cleanupListeners();
    clearPendingTimers();
    splash.remove?.();
    documentRef?.getElementById?.('orbit-splash-style')?.remove?.();
  };

  const dismissNow = () => {
    if (dismissed) return;
    dismissed = true;
    cleanupListeners();
    clearPendingTimers();
    splash.classList?.add?.('is-leaving');
    removeTimer = setTimer(removeNodes, reduced ? 220 : exitMs);
  };

  const beginPlayback = () => {
    if (started || dismissed) return;
    started = true;
    if (fallbackTimer !== null) {
      clearTimer(fallbackTimer);
      fallbackTimer = null;
    }
    documentRef?.removeEventListener?.('visibilitychange', onVisibilityChange);
    offWindowShown?.();
    offWindowShown = null;

    // 等一帧确保窗口已经完成合成上屏，再解除暂停并同步触发星点轨道动画
    requestFrame(() => {
      if (dismissed) return;
      if (splash.dataset) splash.dataset.state = 'playing';
      else splash.setAttribute?.('data-state', 'playing');
      if (!reduced) {
        sparkTimer = setTimer(() => {
          documentRef?.getElementById?.('orbit-splash-spark-motion')?.beginElement?.();
        }, 160);
      }
      waitTimer = setTimer(dismissNow, displayMs);
    });
  };

  const onSkip = () => dismissNow();
  const onVisibilityChange = () => {
    if (documentRef?.visibilityState === 'visible') beginPlayback();
  };

  splash.addEventListener?.('pointerdown', onSkip, { once: true });
  windowRef?.addEventListener?.('keydown', onSkip, { once: true });

  const desktop = windowRef?.orbitDesktop;
  if (desktop?.isDesktop && typeof desktop.isWindowVisible === 'function') {
    if (typeof desktop.onWindowShown === 'function') {
      offWindowShown = desktop.onWindowShown(() => beginPlayback());
    }
    fallbackTimer = setTimer(beginPlayback, visibilityFallbackMs);
    Promise.resolve(desktop.isWindowVisible())
      .then(visible => { if (visible) beginPlayback(); })
      .catch(() => beginPlayback());
  } else if (documentRef?.visibilityState && documentRef.visibilityState !== 'visible') {
    documentRef.addEventListener?.('visibilitychange', onVisibilityChange);
    fallbackTimer = setTimer(beginPlayback, visibilityFallbackMs);
  } else {
    beginPlayback();
  }

  const cancel = () => {
    cleanupListeners();
    clearPendingTimers();
  };

  return { dismissNow, cancel };
}
