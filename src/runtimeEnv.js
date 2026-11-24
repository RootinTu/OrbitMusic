export const IS_DESKTOP_APP = Boolean(typeof window !== 'undefined' && window.orbitDesktop?.isDesktop)
  || (import.meta.env.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).has('desktop-preview'));

export const IS_ANDROID = typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent || '');

export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// 手机 / 平板：有真实触摸点就算，不能只看宽度 —— 安卓横屏和平板都会被 600px 漏掉
export const isHandheld = () => IS_ANDROID
  || /iphone|ipad|ipod|mobile/i.test(navigator.userAgent || '')
  || (navigator.maxTouchPoints || 0) > 1;

// 声波地形按“桌面系统 + 桌面宽度”判断，触屏笔记本仍然属于 PC，不能被触摸点误伤。
export const canUseTerrainGL = () => !/android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent || '') && innerWidth >= 768;
